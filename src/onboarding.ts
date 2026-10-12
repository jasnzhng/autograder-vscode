import * as vscode from "vscode";
import { execFile, spawn } from "child_process";
import { Project } from "./api";
import { cfg } from "./binding";
import {
  buildArchiveCommand, chooseUploads, fnmatchToRegExp, inferArchiveRoots, isArchiveProject, matchExpected,
  normalizePastedCommand, pruneNested,
} from "./files";

export const IGNORE_GLOB = "{**/node_modules/**,**/.git/**,**/env/**,**/.venv/**,**/venv/**,**/__pycache__/**}";
const JUNK = /(^|\/)(node_modules|\.git|env|\.venv|venv|__pycache__|\.pytest_cache|\.ruff_cache|\.mypy_cache|\.DS_Store|.*\.egg-info)(\/|$)/;

/** Has this workspace been told how to build/what to upload? */
export function isConfigured(folder: vscode.WorkspaceFolder): boolean {
  const c = cfg(folder);
  return c.get<string | null>("buildCommand") != null || (c.get<string[]>("submitFiles") ?? []).length > 0;
}

/**
 * First-run setup, driven by what autograder.io says the project expects:
 *  - individual files → confirm which workspace files match each expected pattern
 *  - a single archive (e.g. submit.tar.gz) → paste the spec's tar command, or pick what goes in it
 * Saves `autograder.buildCommand` / `autograder.submitFiles` to the workspace folder settings.
 */
export async function configureSubmission(folder: vscode.WorkspaceFolder, project: Project): Promise<boolean> {
  const expected = project.expected_student_files;
  if (!expected.length) {
    void vscode.window.showWarningMessage(`${project.name} doesn't list any expected files on autograder.io; set autograder.submitFiles manually.`);
    return false;
  }
  return isArchiveProject(expected) ? configureArchive(folder, project) : configureFiles(folder, project);
}

// ---- individual files --------------------------------------------------------

async function configureFiles(folder: vscode.WorkspaceFolder, project: Project): Promise<boolean> {
  const all = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*"), IGNORE_GLOB, 20000);
  const rels = all.map((u) => vscode.workspace.asRelativePath(u, false));
  const matched = matchExpected(rels, project.expected_student_files);
  const { files: preselected } = chooseUploads(matched);

  const items: Array<vscode.QuickPickItem & { rel?: string }> = [];
  for (const m of matched) {
    const need = m.min === m.max ? `${m.min}` : `${m.min}–${m.max}`;
    items.push({ label: `${m.pattern}  (needs ${need})`, kind: vscode.QuickPickItemKind.Separator });
    if (!m.matches.length) items.push({ label: `$(warning) No file named like ${m.pattern} in this folder` });
    for (const rel of m.matches) items.push({ label: `$(file) ${rel}`, rel, picked: preselected.includes(rel) });
  }
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true, ignoreFocusOut: true,
    title: `${project.name}: which files should be submitted?`,
    placeHolder: "Files autograder.io expects for this project — pre-selected from this folder",
  });
  if (!picked) return false;
  const chosen = picked.filter((p) => p.rel).map((p) => p.rel!);
  if (!chosen.length) return false;
  await cfg(folder).update("submitFiles", chosen, vscode.ConfigurationTarget.WorkspaceFolder);
  await cfg(folder).update("buildCommand", "", vscode.ConfigurationTarget.WorkspaceFolder);
  void vscode.window.showInformationMessage(`Autograder: will submit ${chosen.length} file(s). Change with "Autograder: Configure Submission Files".`);
  return true;
}

// ---- archive (tarball) ----------------------------------------------------------

async function configureArchive(folder: vscode.WorkspaceFolder, project: Project): Promise<boolean> {
  const pattern = project.expected_student_files[0].pattern;
  let archive = pattern;
  if (/[*?[]/.test(pattern)) {
    const name = await vscode.window.showInputBox({
      title: `autograder.io expects an archive matching "${pattern}"`, prompt: "Name of the archive to create",
      value: pattern.replace(/\*/g, "submit").replace(/\?/g, "x"), ignoreFocusOut: true,
      validateInput: (v) => (fnmatchToRegExp(pattern).test(v) ? undefined : `Must match ${pattern}`),
    });
    if (!name) return false;
    archive = name;
  }

  type Choice = vscode.QuickPickItem & { id: "paste" | "pick" | "script" | "none" };
  const choices: Choice[] = [
    { id: "paste", label: "$(clippy) Paste the command from the project spec",
      detail: `Most specs give a tar command that creates ${archive}` },
    { id: "pick", label: "$(checklist) Choose the files and folders to include",
      detail: "We'll write the tar command for you" },
  ];
  const scripts = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "{makesubmit,makesubmit.sh,bin/makesubmit}"), null, 1);
  if (scripts.length) {
    const rel = vscode.workspace.asRelativePath(scripts[0], false);
    choices.push({ id: "script", label: `$(tools) Run ./${rel}`, detail: "Your own script in this folder" });
  }
  choices.push({ id: "none", label: "$(circle-slash) I'll build it myself", detail: `Just upload ${archive} as it is` });

  const how = await vscode.window.showQuickPick(choices, {
    title: `${project.name} is submitted as ${archive}. How should it be built?`, ignoreFocusOut: true,
  });
  if (!how) return false;

  let command: string | undefined;
  switch (how.id) {
    case "paste": {
      const pasted = await vscode.window.showInputBox({
        title: `Paste the command that creates ${archive}`, ignoreFocusOut: true,
        placeHolder: `e.g. tar -czvf ${archive} bin src sql`,
        prompt: "Runs in the workspace root before each submission. Multiple lines are joined with &&.",
      });
      if (!pasted) return false;
      command = normalizePastedCommand(pasted);
      if (!command.includes(archive)) {
        const go = await vscode.window.showWarningMessage(
          `That command doesn't mention ${archive}. Use it anyway?`, { modal: true }, "Use it");
        if (!go) return false;
      }
      break;
    }
    case "pick":
      command = await pickArchiveContents(folder, archive);
      if (command === undefined) return false;
      break;
    case "script":
      command = `./${vscode.workspace.asRelativePath(scripts[0], false)}`;
      break;
    case "none":
      command = "";
      break;
  }
  await cfg(folder).update("buildCommand", command, vscode.ConfigurationTarget.WorkspaceFolder);
  await cfg(folder).update("submitFiles", [], vscode.ConfigurationTarget.WorkspaceFolder);
  void vscode.window.showInformationMessage(
    command ? `Autograder: before each submission we'll run: ${command}` : `Autograder: will upload ${archive} as-is.`);
  return true;
}

async function pickArchiveContents(folder: vscode.WorkspaceFolder, archive: string): Promise<string | undefined> {
  const root = folder.uri.fsPath;
  const candidates = await listCandidates(root);
  // If an archive already exists (built by hand earlier), pre-check what's in it.
  const previous = await listArchive(root, archive);
  const pre = new Set(previous ? inferArchiveRoots(previous) : []);

  const items: Array<vscode.QuickPickItem & { path: string }> = candidates.map((c) => ({
    label: `${c.dir ? "$(folder)" : "$(file)"} ${c.path}${c.dir ? "/" : ""}`,
    path: c.path,
    picked: pre.has(c.path),
  }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true, ignoreFocusOut: true, matchOnDescription: true,
    title: `What goes in ${archive}?`,
    placeHolder: previous
      ? `Pre-selected from your existing ${archive}. Type to filter; pick folders to include everything in them.`
      : "Check the files/folders the spec says to include. Type to filter; folders include everything inside.",
  });
  if (!picked?.length) return undefined;

  const generated = buildArchiveCommand(archive, pruneNested(picked.map((p) => p.path)), process.platform);
  // Let them eyeball/tweak it — this is the one place a typo costs a submission.
  return vscode.window.showInputBox({
    title: "Command that will build your submission", value: generated, ignoreFocusOut: true,
    prompt: "Edit if the spec needs extra flags. Runs in the workspace root.",
  });
}

/** Folders and files a student might put in an archive: tracked + untracked-but-not-ignored. */
async function listCandidates(root: string): Promise<Array<{ path: string; dir: boolean }>> {
  let files: string[];
  try {
    files = (await exec("git", ["ls-files", "--cached", "--others", "--exclude-standard"], root)).split("\n").filter(Boolean);
  } catch {
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, "**/*"), IGNORE_GLOB, 5000);
    files = uris.map((u) => vscode.workspace.asRelativePath(u, false));
  }
  files = files.filter((f) => !JUNK.test(f));
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const out = [...[...dirs].map((path) => ({ path, dir: true })), ...files.map((path) => ({ path, dir: false }))];
  // Shallow first, folders before files, then alphabetical: top-level choices are the common case.
  return out.sort((a, b) => a.path.split("/").length - b.path.split("/").length
    || Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path));
}

async function listArchive(root: string, archive: string): Promise<string[] | undefined> {
  try {
    return (await exec("tar", ["-tf", archive], root)).split("\n").filter(Boolean);
  } catch { return undefined; }
}

function exec(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((res, rej) => execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 },
    (err, out) => err ? rej(err) : res(out)));
}

// ---- running the build ----------------------------------------------------------

/** Run `autograder.buildCommand` (configuring it first if needed). False if cancelled or failed. */
export async function runBuild(folder: vscode.WorkspaceFolder, project: Project, output: vscode.OutputChannel): Promise<boolean> {
  if (!isConfigured(folder) && !(await configureSubmission(folder, project))) return false;
  const command = cfg(folder).get<string | null>("buildCommand") ?? "";
  if (!command.trim()) return true;

  output.appendLine(`$ ${command}`);
  const code = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Building submission: ${command}` },
    () => new Promise<number>((resolve) => {
      const child = spawn(command, { cwd: folder.uri.fsPath, shell: true, env: process.env });
      child.stdout.on("data", (d) => output.append(d.toString()));
      child.stderr.on("data", (d) => output.append(d.toString()));
      child.on("error", (e) => { output.appendLine(String(e)); resolve(-1); });
      child.on("close", (c) => resolve(c ?? -1));
    }));
  if (code !== 0) {
    output.show(true);
    void vscode.window.showErrorMessage(`Build command exited with code ${code}. Nothing was submitted.`, "Show Output")
      .then((p) => p && output.show());
    return false;
  }
  return true;
}
