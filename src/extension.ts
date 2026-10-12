import * as vscode from "vscode";
import { baseUrl, confirmServer, Session } from "./session";
import { cfg, pickProject, resolveProjectId, setDevMode, workspaceRoot } from "./binding";
import { AutograderPanel, PanelDeps } from "./panel";
import { pollUntilDone, runPrepare, runSubmit, scoreLabel } from "./submit";
import { configureSubmission, isConfigured } from "./onboarding";
import { AutograderClient, User } from "./api";

export function activate(context: vscode.ExtensionContext) {
  // Safety: a development build never really submits unless autograder.dryRun is explicitly false.
  setDevMode(context.extensionMode === vscode.ExtensionMode.Development);
  const session = new Session(context.secrets);
  const output = vscode.window.createOutputChannel("Autograder");
  const diagnostics = vscode.languages.createDiagnosticCollection("autograder");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "autograder.openPanel";
  context.subscriptions.push(output, diagnostics, status);

  /** Signed-in client + bound project for the active workspace folder. */
  const connect: PanelDeps["connect"] = async (interactive) => {
    const folder = workspaceRoot();
    if (!folder) {
      if (interactive) void vscode.window.showErrorMessage("Open your project folder first.");
      return undefined;
    }
    const auth = interactive ? await session.ensureClient(true) : await session.ensureClient(false).catch(() => undefined);
    if (!auth) return undefined;
    const projectId = await resolveProjectId(folder, auth.client, auth.user, { interactive });
    if (!projectId) return undefined;
    void vscode.commands.executeCommand("setContext", "autograder.bound", true);
    if (interactive) void offerSetup(folder, auth.client, projectId).catch(() => undefined);
    return { ...auth, folder, projectId };
  };

  const panelDeps: PanelDeps = {
    extensionUri: context.extensionUri,
    storageUri: context.globalStorageUri,
    diagnostics,
    state: context.workspaceState,
    connect,
  };

  /** Show results for a submission, then put its failures in the Problems panel. */
  async function problemsFor(pk: number) {
    AutograderPanel.show(panelDeps, pk);
    // The sidebar may still be resolving; use whichever instance exists, else open a tab.
    const view = AutograderPanel.instance ?? AutograderPanel.openInEditor(panelDeps, pk);
    await view.showProblems(pk);
  }

  /** Once per workspace, offer setup when autograder.io's expectations aren't configured yet. */
  async function offerSetup(folder: vscode.WorkspaceFolder, client: AutograderClient, projectId: number) {
    const flag = `autograder.offeredSetup.${projectId}`;
    if (isConfigured(folder) || context.workspaceState.get(flag)) return;
    await context.workspaceState.update(flag, true);
    const project = await client.project(projectId);
    const pick = await vscode.window.showInformationMessage(
      `Autograder: ${project.name} expects ${project.expected_student_files.map((e) => e.pattern).join(", ")}. ` +
      "Set up how it's built and submitted?", "Set up", "Later");
    if (pick === "Set up") await configureSubmission(folder, project);
  }

  /** After "Build & Open in Browser", watch for the upload made on the website and report its score. */
  let watching: ReturnType<typeof setTimeout> | undefined;
  function watchForUpload(client: AutograderClient, user: User, projectId: number, since: number) {
    if (watching) clearTimeout(watching);
    const deadline = Date.now() + 30 * 60 * 1000;
    const tick = async () => {
      watching = undefined;
      try {
        const group = await client.myGroup(user.pk, projectId);
        const subs = group ? await client.submissions(group.pk) : [];
        const fresh = subs.filter((s) => Date.parse(s.timestamp) >= since - 5000).sort((a, b) => b.pk - a.pk)[0];
        if (fresh) {
          AutograderPanel.show(panelDeps, fresh.pk);
          void updateStatus();
          const done = await pollUntilDone(client, fresh);
          void updateStatus();
          AutograderPanel.refreshAll(done.pk);
          if (done.status === "finished_grading" || done.status === "waiting_for_deferred") {
            const res = await client.results(done);
            const pick = await vscode.window.showInformationMessage(
              `Autograder: submission #${done.pk} scored ${scoreLabel(res)}.`, "View results", "Show failures in Problems");
            if (pick === "View results") AutograderPanel.show(panelDeps, done.pk);
            if (pick === "Show failures in Problems") await problemsFor(done.pk);
          }
          return;
        }
      } catch { /* network blip: keep watching */ }
      if (Date.now() < deadline) watching = setTimeout(tick, 15000);
    };
    watching = setTimeout(tick, 15000);
  }
  context.subscriptions.push({ dispose: () => watching && clearTimeout(watching) });

  async function updateStatus() {
    const folder = workspaceRoot();
    if (!folder) { status.hide(); return; }
    try {
      const conn = await connect(false);
      if (!conn) { status.hide(); return; }
      const [project, group] = await Promise.all([
        conn.client.project(conn.projectId), conn.client.myGroup(conn.user.pk, conn.projectId)]);
      let text = "$(beaker) Autograder";
      if (group) {
        const subs = await conn.client.submissions(group.pk);
        const latest = subs.sort((a, b) => b.pk - a.pk)[0];
        if (latest?.status === "finished_grading") text += ` ${scoreLabel(await conn.client.results(latest))}`;
        else if (latest) text += ` $(sync~spin) ${latest.status.replace(/_/g, " ")}`;
        if (project.submission_limit_per_day != null) {
          text += ` · ${Math.max(0, project.submission_limit_per_day - group.num_submits_towards_limit)} left today`;
        }
      }
      status.text = text;
      status.tooltip = `${project.name} — click to open the Autograder panel`;
      status.show();
    } catch {
      status.hide();
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("autograder.signIn", async () => {
      if (await session.signIn()) { void updateStatus(); AutograderPanel.refreshAll(); }
    }),
    vscode.commands.registerCommand("autograder.signOut", async () => { await session.signOut(); status.hide(); }),

    AutograderPanel.registerSidebar(panelDeps),
    vscode.commands.registerCommand("autograder.openPanel", (pk?: number) => { AutograderPanel.show(panelDeps, pk); }),
    vscode.commands.registerCommand("autograder.openInEditor", (pk?: number) => { AutograderPanel.openInEditor(panelDeps, pk); }),
    vscode.commands.registerCommand("autograder.refresh", () => AutograderPanel.refreshAll()),

    vscode.commands.registerCommand("autograder.selectProject", async () => {
      const folder = workspaceRoot();
      const auth = folder && await session.ensureClient();
      if (!folder || !auth) return;
      if (await pickProject(folder, auth.client, auth.user)) {
        void updateStatus();
        AutograderPanel.refreshAll();
      }
    }),

    vscode.commands.registerCommand("autograder.openInBrowser", async () => {
      const folder = workspaceRoot();
      const id = folder && cfg(folder).get<number | null>("projectId");
      let base: string;
      try { base = baseUrl(); } catch (e) { void vscode.window.showErrorMessage(`Autograder: ${(e as Error).message}`); return; }
      if (!(await confirmServer(base, "Its pages could imitate autograder.io's sign-in."))) return;
      await vscode.env.openExternal(vscode.Uri.parse(id ? `${base}/web/project/${id}` : base));
    }),

    vscode.commands.registerCommand("autograder.clearProblems", () => diagnostics.clear()),

    vscode.commands.registerCommand("autograder.configureSubmission", async () => {
      const conn = await connect(true);
      if (!conn) return;
      if (await configureSubmission(conn.folder, await conn.client.project(conn.projectId))) {
        AutograderPanel.refreshAll();
      }
    }),

    vscode.commands.registerCommand("autograder.prepare", async () => {
      await vscode.workspace.saveAll(false);
      const conn = await connect(true);
      if (!conn) return;
      try {
        const done = await runPrepare({ ...conn, output, state: context.workspaceState });
        if (done) watchForUpload(conn.client, conn.user, conn.projectId, done.preparedAt);
      } catch (e) {
        void vscode.window.showErrorMessage(`Autograder: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("autograder.submit", async () => {
      await vscode.workspace.saveAll(false);
      const conn = await connect(true);
      if (!conn) return;
      try {
        const outcome = await runSubmit({ ...conn, output });
        if (!outcome) return;
        const { submission, finished } = outcome;
        AutograderPanel.show(panelDeps, submission.pk);
        void updateStatus();
        const done = await finished;
        void updateStatus();
        AutograderPanel.refreshAll(done.pk);
        if (done.status === "finished_grading" || done.status === "waiting_for_deferred") {
          const res = await conn.client.results(done);
          const pick = await vscode.window.showInformationMessage(
            `Autograder: submission #${done.pk} scored ${scoreLabel(res)}.`, "View results", "Show failures in Problems");
          if (pick === "View results") AutograderPanel.show(panelDeps, done.pk);
          if (pick === "Show failures in Problems") {
            await problemsFor(done.pk);
          }
        } else {
          void vscode.window.showWarningMessage(`Autograder: submission #${done.pk} ended with status "${done.status}".`);
        }
      } catch (e) {
        void vscode.window.showErrorMessage(`Autograder: ${(e as Error).message}`);
      }
    }),

    session.onDidChange(() => void updateStatus()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("autograder")) void updateStatus();
    }),
  );

  void updateStatus();
}

export function deactivate() {}
