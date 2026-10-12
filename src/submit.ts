import * as vscode from "vscode";
import { ACTIVE_STATUSES, AutograderClient, Group, Project, Submission, User, num } from "./api";
import { cfg, isDryRun } from "./binding";
import { chooseUploads, formatBytes, matchExpected } from "./files";
import * as git from "./git";
import { IGNORE_GLOB, runBuild } from "./onboarding";
import { recordPending } from "./pending";

export interface SubmitContext {
  folder: vscode.WorkspaceFolder;
  client: AutograderClient;
  user: User;
  projectId: number;
  output: vscode.OutputChannel;
}

export interface SubmitOutcome {
  submission: Submission;
  finished: Promise<Submission>;
}

export async function runSubmit(ctx: SubmitContext): Promise<SubmitOutcome | undefined> {
  const { client, folder, user, projectId, output } = ctx;
  const project = await client.project(projectId);

  if (project.disallow_student_submissions) {
    void vscode.window.showErrorMessage(`${project.name} isn't accepting student submissions right now.`);
    return;
  }

  const dryRun = isDryRun(folder);
  const group = await ensureGroup(client, user, project, dryRun);
  if (!group) return;

  const existing = await client.submissions(group.pk);
  const active = existing.find((s) => ACTIVE_STATUSES.includes(s.status));
  if (active) {
    void vscode.window.showWarningMessage(
      `Submission #${active.pk} is still ${active.status.replace(/_/g, " ")}. autograder.io won't accept another until it finishes.`);
    return;
  }

  // 1. Build step (e.g. the spec's tar command), configured on first use.
  if (!(await runBuild(folder, project, output))) return;

  // 2. Pick files.
  const picked = await collectFiles(folder, project);
  if (!picked) return;

  // 3. Confirm, showing quota + honor pledge.
  if (!(await confirm(project, group, picked, dryRun))) return;

  const files = await Promise.all(picked.map(async (p) => ({
    name: p.rel.split("/").pop()!,
    data: await vscode.workspace.fs.readFile(p.uri),
  })));

  if (dryRun) {
    output.appendLine(`[dry run] Would POST ${files.length} file(s) to group ${group.pk}: ` +
      files.map((f) => `${f.name} (${formatBytes(f.data.byteLength)})`).join(", "));
    output.show(true);
    void vscode.window.showInformationMessage(
      `Dry run: would submit ${files.map((f) => f.name).join(", ")} to ${project.name}. Nothing was uploaded.`);
    return;
  }

  // 4. Snapshot the tree *before* uploading, so it reflects exactly what was built.
  const root = cfg(folder).get<boolean>("snapshotCommits") ? await git.repoRoot(folder.uri.fsPath) : undefined;
  let snap: Awaited<ReturnType<typeof git.snapshotWorkingTree>> | undefined;
  if (root) {
    snap = await git.snapshotWorkingTree(root, `autograder: ${project.name} submission`).catch((e) => {
      output.appendLine(`Couldn't snapshot git state: ${e.message}`);
      return undefined;
    });
  }

  // 5. Upload.
  const submission = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Submitting to ${project.name}…` },
    () => client.submit(group.pk, files));

  if (root && snap) {
    await git.pinSnapshot(root, submission.pk, snap).catch((e) => output.appendLine(`Couldn't pin snapshot: ${e.message}`));
  }
  if (submission.discarded_files.length) {
    void vscode.window.showWarningMessage(`autograder.io discarded: ${submission.discarded_files.join(", ")}`);
  }
  const missing = Object.keys(submission.missing_files ?? {});
  if (missing.length) {
    void vscode.window.showWarningMessage(`autograder.io reports missing files: ${missing.join(", ")}`);
  }

  return { submission, finished: pollUntilDone(client, submission) };
}

async function ensureGroup(client: AutograderClient, user: User, project: Project, dryRun: boolean): Promise<Group | undefined> {
  const group = await client.myGroup(user.pk, project.pk);
  if (group) return group;
  if (dryRun) {
    // Creating a group is a server-side write; a dry run must not do it.
    void vscode.window.showInformationMessage(
      `Dry run: you have no group for ${project.name} yet. A real submit would ask to create one. Stopping here.`);
    return undefined;
  }
  if (project.max_group_size === 1 || project.min_group_size === 1) {
    const ok = await vscode.window.showInformationMessage(
      `You don't have a group for ${project.name} yet. Work alone on this project?`, { modal: true }, "Work alone");
    return ok ? client.createSoloGroup(project.pk) : undefined;
  }
  const open = await vscode.window.showWarningMessage(
    `Register your group for ${project.name} on autograder.io first.`, "Open autograder.io");
  if (open) void vscode.env.openExternal(vscode.Uri.parse(`https://autograder.io/web/project/${project.pk}`));
  return undefined;
}

interface Picked { uri: vscode.Uri; rel: string; size: number; mtime: number }

async function collectFiles(folder: vscode.WorkspaceFolder, project: Project): Promise<Picked[] | undefined> {
  const globs = cfg(folder).get<string[]>("submitFiles") ?? [];
  let rels: string[];
  if (globs.length) {
    const uris = (await Promise.all(globs.map((g) =>
      vscode.workspace.findFiles(new vscode.RelativePattern(folder, g), IGNORE_GLOB)))).flat();
    rels = [...new Set(uris.map((u) => vscode.workspace.asRelativePath(u, false)))];
    const names = rels.map((r) => r.split("/").pop());
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) { void vscode.window.showErrorMessage(`Two files are both named "${dup}"; autograder.io flattens paths.`); return; }
  } else {
    const all = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*"), IGNORE_GLOB, 20000);
    const relAll = all.map((u) => vscode.workspace.asRelativePath(u, false));
    const { files, problems } = chooseUploads(matchExpected(relAll, project.expected_student_files));
    if (problems.length) {
      void vscode.window.showErrorMessage(`Not submitting: ${problems.join(" ")}`);
      return;
    }
    rels = files;
  }
  if (!rels.length) { void vscode.window.showErrorMessage("No files to submit."); return; }
  return Promise.all(rels.map(async (rel) => {
    const uri = vscode.Uri.joinPath(folder.uri, rel);
    const st = await vscode.workspace.fs.stat(uri);
    return { uri, rel, size: st.size, mtime: st.mtime };
  }));
}

async function confirm(project: Project, group: Group, files: Picked[], dryRun: boolean): Promise<boolean> {
  const limit = project.submission_limit_per_day;
  const used = group.num_submits_towards_limit;
  const lines: string[] = [];
  lines.push("Files:");
  for (const f of files) lines.push(`  • ${f.rel} (${formatBytes(f.size)}, modified ${age(f.mtime)})`);
  lines.push("");
  if (limit != null) {
    const bonus = group.bonus_submissions_remaining;
    lines.push(`Today: ${used} of ${limit} submissions used${bonus ? ` (+${bonus} bonus left)` : ""}.`);
    if (used >= limit && !bonus) {
      if (!project.allow_submissions_past_limit) {
        void vscode.window.showErrorMessage(`You've used all ${limit} submissions for today on ${project.name}.`);
        return false;
      }
      lines.push("⚠️ This is past the daily limit — you'll get reduced feedback and it may not count.");
    }
  }
  if (project.soft_closing_time && new Date(project.soft_closing_time) < new Date() && !group.extended_due_date) {
    lines.push("⚠️ The deadline has passed.");
  }
  if (project.use_honor_pledge) {
    lines.push("", "Honor pledge:", project.honor_pledge_text);
  }
  if (dryRun) lines.unshift("DRY RUN — nothing will be uploaded.", "");
  const action = dryRun ? "Dry Run (no upload)" : project.use_honor_pledge ? "I Agree — Submit" : "Submit";
  const pick = await vscode.window.showWarningMessage(
    `${dryRun ? "[Dry run] " : ""}Submit to ${project.name}?`, { modal: true, detail: lines.join("\n") }, action);
  return pick === action;
}

export function pollUntilDone(client: AutograderClient, sub: Submission): Promise<Submission> {
  const done = (s: Submission) => !ACTIVE_STATUSES.includes(s.status);
  return Promise.resolve(vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Autograder" },
    async (progress) => {
      let current = sub;
      const started = Date.now();
      while (!done(current) && Date.now() - started < 60 * 60 * 1000) {
        const where = current.status === "queued" && current.position_in_queue
          ? `queued (#${current.position_in_queue})` : current.status.replace(/_/g, " ");
        progress.report({ message: `#${current.pk} ${where}` });
        await new Promise((r) => setTimeout(r, 5000));
        try { current = await client.submission(sub.pk); } catch { /* transient; keep polling */ }
      }
      return current;
    }));
}

export function scoreLabel(r: { total_points: string | number; total_points_possible: string | number }): string {
  return `${num(r.total_points)}/${num(r.total_points_possible)}`;
}

function age(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export interface PrepareContext {
  folder: vscode.WorkspaceFolder;
  client: AutograderClient;
  projectId: number;
  output: vscode.OutputChannel;
  state: vscode.Memento;
}

/**
 * The no-upload path (what a hand-written `makesubmit` does): build the submission, check it
 * against what autograder.io expects, snapshot git, then open the project page and reveal the
 * file so the student uploads it on the website themselves.
 */
export async function runPrepare(ctx: PrepareContext): Promise<{ preparedAt: number } | undefined> {
  const { client, folder, projectId, output, state } = ctx;
  const project = await client.project(projectId);
  if (!(await runBuild(folder, project, output))) return;
  const picked = await collectFiles(folder, project);
  if (!picked) return;
  const preparedAt = Date.now();

  const root = cfg(folder).get<boolean>("snapshotCommits") ? await git.repoRoot(folder.uri.fsPath) : undefined;
  if (root) {
    try {
      const snap = await git.snapshotWorkingTree(root, `autograder: ${project.name} (built for upload)`);
      const files = await Promise.all(picked.map(async (p) => ({ name: p.rel.split("/").pop()!, data: await vscode.workspace.fs.readFile(p.uri) })));
      await recordPending(state, projectId, root, snap, files);
    } catch (e) {
      output.appendLine(`Couldn't snapshot git state: ${(e as Error).message}`);
    }
  }

  await vscode.env.openExternal(vscode.Uri.parse(`${baseUrlOf()}/web/project/${projectId}`));
  if (picked.length === 1) await vscode.commands.executeCommand("revealFileInOS", picked[0].uri);
  void vscode.window.showInformationMessage(
    `Built ${picked.map((p) => `${p.rel} (${formatBytes(p.size)})`).join(", ")}. ` +
    `Upload it on the autograder.io page that just opened — results will show up in the Autograder panel.`);
  return { preparedAt };
}

function baseUrlOf(): string {
  return vscode.workspace.getConfiguration("autograder").get<string>("baseUrl") || "https://autograder.io";
}
