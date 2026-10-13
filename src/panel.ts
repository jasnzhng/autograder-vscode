import * as vscode from "vscode";
import * as path from "path";
import { AutograderClient, CommandResult, Group, hasDiff, Project, Submission, SubmissionResults, User } from "./api";
import { buildView, expectedText } from "./diff";
import { isDryRun } from "./binding";
import { isConfigured } from "./onboarding";
import * as git from "./git";
import { LinkTable, publishProblems, segmentOutput } from "./problems";
import { RefResolver } from "./resolver";
import { matchPending } from "./pending";

export interface PanelDeps {
  extensionUri: vscode.Uri;
  storageUri: vscode.Uri;
  diagnostics: vscode.DiagnosticCollection;
  state: vscode.Memento;
  /** Signed-in client + bound project for the current workspace, prompting if needed. */
  connect(interactive: boolean): Promise<{ client: AutograderClient; user: User; folder: vscode.WorkspaceFolder; projectId: number } | undefined>;
}

interface SnapshotView { sha: string; short: string; subject: string; kind: "exact" | "approx"; dirty: boolean }

type Host = { kind: "sidebar" | "editor"; webview: vscode.Webview; reveal(): void; column(): vscode.ViewColumn | undefined };

/**
 * The autograder UI: a webview that renders the project, its submissions and their results
 * using the REST API, with clickable file references in test output. The same controller runs
 * in the activity-bar sidebar (default) or popped out into an editor tab.
 */
export class AutograderPanel {
  static readonly viewId = "autograder.results";
  private static sidebar?: AutograderPanel;
  private static editor?: AutograderPanel;
  private static sidebarFocus?: number;
  private disposables: vscode.Disposable[] = [];
  private links = new LinkTable();
  private conn?: Awaited<ReturnType<PanelDeps["connect"]>>;
  private project?: Project;
  private group?: Group;
  private submissions: Submission[] = [];
  private snapshots = new Map<number, SnapshotView>();
  private results = new Map<number, SubmissionResults>();
  private resolvers = new Map<number, RefResolver>();
  private repoRoot?: string;
  private pendingFocus?: number;

  /** Show results: in the editor tab if one is open, otherwise in the sidebar. */
  static show(deps: PanelDeps, focusSubmission?: number): AutograderPanel | undefined {
    if (AutograderPanel.editor) return AutograderPanel.openInEditor(deps, focusSubmission);
    if (AutograderPanel.sidebar) {
      AutograderPanel.sidebar.host.reveal();
      void AutograderPanel.sidebar.refresh(focusSubmission);
    } else {
      // The view resolves (and sends "ready") once it becomes visible.
      AutograderPanel.sidebarFocus = focusSubmission;
      void vscode.commands.executeCommand(`${AutograderPanel.viewId}.focus`);
    }
    return AutograderPanel.sidebar;
  }

  static openInEditor(deps: PanelDeps, focusSubmission?: number): AutograderPanel {
    if (AutograderPanel.editor) {
      AutograderPanel.editor.host.reveal();
      void AutograderPanel.editor.refresh(focusSubmission);
      return AutograderPanel.editor;
    }
    const panel = vscode.window.createWebviewPanel("autograder", "Autograder", vscode.ViewColumn.Beside, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, "media")],
    });
    const view = new AutograderPanel(deps, {
      kind: "editor", webview: panel.webview,
      reveal: () => panel.reveal(), column: () => panel.viewColumn,
    });
    view.pendingFocus = focusSubmission;
    panel.onDidDispose(() => { AutograderPanel.editor = undefined; view.dispose(); });
    return (AutograderPanel.editor = view);
  }

  static registerSidebar(deps: PanelDeps): vscode.Disposable {
    return vscode.window.registerWebviewViewProvider(AutograderPanel.viewId, {
      resolveWebviewView(webviewView) {
        webviewView.webview.options = {
          enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, "media")],
        };
        const view = new AutograderPanel(deps, {
          kind: "sidebar", webview: webviewView.webview,
          reveal: () => webviewView.show(true), column: () => undefined,
        });
        view.pendingFocus = AutograderPanel.sidebarFocus;
        AutograderPanel.sidebarFocus = undefined;
        webviewView.onDidDispose(() => { AutograderPanel.sidebar = undefined; view.dispose(); });
        AutograderPanel.sidebar = view;
      },
    }, { webviewOptions: { retainContextWhenHidden: true } });
  }

  /** The most prominent live instance (for "Show failures in Problems" etc.). */
  static get instance() { return AutograderPanel.editor ?? AutograderPanel.sidebar; }

  static refreshAll(focus?: number) {
    for (const v of [AutograderPanel.sidebar, AutograderPanel.editor]) void v?.refresh(focus);
  }

  private constructor(private deps: PanelDeps, private host: Host) {
    host.webview.html = this.html();
    host.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => this.post({ type: "error", message: String(e?.message ?? e) })), null, this.disposables);
  }

  private dispose() {
    this.disposables.forEach((d) => d.dispose());
  }

  private post(msg: unknown) { void this.host.webview.postMessage(msg); }

  // ---- data ---------------------------------------------------------------

  async refresh(focus?: number): Promise<void> {
    this.post({ type: "loading" });
    try {
      this.conn = await this.deps.connect(true);
      if (!this.conn) { this.post({ type: "signedOut" }); return; }
      const { client, user, folder, projectId } = this.conn;
      [this.project, this.group] = await Promise.all([client.project(projectId), client.myGroup(user.pk, projectId)]);
      this.submissions = this.group ? await client.submissions(this.group.pk) : [];
      this.submissions.sort((a, b) => b.pk - a.pk);
      this.repoRoot = await git.repoRoot(folder.uri.fsPath);
      await this.loadSnapshots();
      this.pushState();
      const target = focus ?? this.submissions[0]?.pk;
      if (target) await this.select(target);
    } catch (e) {
      this.post({ type: "error", message: (e as Error).message });
    }
  }

  private async loadSnapshots() {
    this.snapshots.clear();
    if (!this.repoRoot) return;
    let exact = await git.listSnapshots(this.repoRoot);
    // Uploads done on the website after "Build & Open in Browser": link them by file hash.
    const matched = await matchPending(this.deps.state, this.conn!.projectId, this.repoRoot, this.conn!.client,
      this.submissions, new Set(exact.keys())).catch(() => []);
    if (matched.length) exact = await git.listSnapshots(this.repoRoot);
    await Promise.all(this.submissions.map(async (s) => {
      const snap = exact.get(s.pk);
      const sha = snap?.sha ?? await git.approxCommitAt(this.repoRoot!, s.timestamp);
      if (!sha) return;
      const log = await git.shortLog(this.repoRoot!, snap?.head ?? sha);
      const [short, ...subject] = log.split(" ");
      this.snapshots.set(s.pk, { sha, short, subject: subject.join(" "), kind: snap ? "exact" : "approx", dirty: snap?.dirty ?? false });
    }));
  }

  private pushState() {
    const p = this.project!;
    this.post({
      type: "state",
      host: this.host.kind,
      user: this.conn!.user.username,
      project: {
        pk: p.pk, name: p.name, deadline: p.soft_closing_time, limit: p.submission_limit_per_day,
        pledge: p.use_honor_pledge, expected: p.expected_student_files.map((e) => e.pattern),
      },
      group: this.group && {
        usedToday: this.group.num_submits_towards_limit, bonus: this.group.bonus_submissions_remaining,
        members: this.group.member_names, extension: this.group.extended_due_date,
      },
      dryRun: isDryRun(this.conn!.folder),
      method: vscode.workspace.getConfiguration("autograder", this.conn!.folder.uri).get<string>("submitMethod") ?? "browser",
      configured: isConfigured(this.conn!.folder),
      submissions: this.submissions.map((s) => ({
        pk: s.pk, timestamp: s.timestamp, status: s.status, files: s.submitted_filenames,
        pastLimit: s.is_past_daily_limit, bonus: s.is_bonus_submission, queue: s.position_in_queue,
        score: this.results.has(s.pk) ? scoreOf(this.results.get(s.pk)!) : undefined,
        snapshot: this.snapshots.get(s.pk),
      })),
    });
  }

  async select(pk: number) {
    const sub = this.submissions.find((s) => s.pk === pk);
    if (!sub || !this.conn) return;
    this.post({ type: "selected", pk });
    let res = this.results.get(pk);
    // Only cache once grading is done; in-progress results keep changing.
    if (!res || sub.status !== "finished_grading") {
      res = await this.conn.client.results(sub);
      this.results.set(pk, res);
    }
    this.post({ type: "results", pk, results: res, score: scoreOf(res) });
    // Fill in scores for the list lazily (a few at a time) so the sidebar becomes informative.
    void this.prefetchScores();
  }

  private prefetching = false;
  private async prefetchScores() {
    if (this.prefetching || !this.conn) return;
    this.prefetching = true;
    try {
      for (const s of this.submissions) {
        if (this.results.has(s.pk) || s.status !== "finished_grading") continue;
        const r = await this.conn.client.results(s).catch(() => undefined);
        if (r) { this.results.set(s.pk, r); this.post({ type: "score", pk: s.pk, score: scoreOf(r) }); }
      }
    } finally { this.prefetching = false; }
  }

  private resolverFor(sub: Submission): RefResolver {
    let r = this.resolvers.get(sub.pk);
    if (!r) {
      r = new RefResolver(this.conn!.folder.uri, this.conn!.client, sub, this.deps.storageUri);
      this.resolvers.set(sub.pk, r);
    }
    return r;
  }

  // ---- messages from the webview -------------------------------------------

  private async onMessage(m: any) {
    switch (m.type) {
      case "ready": return this.refresh(this.pendingFocus);
      case "refresh": return this.refresh(m.pk);
      case "select": return this.select(m.pk);
      case "submit": return vscode.commands.executeCommand("autograder.submit");
      case "prepare": return vscode.commands.executeCommand("autograder.prepare");
      case "configure": return vscode.commands.executeCommand("autograder.configureSubmission");
      case "signIn": await vscode.commands.executeCommand("autograder.signIn"); return this.refresh();
      case "openInBrowser": return vscode.commands.executeCommand("autograder.openInBrowser");
      case "popOut": return vscode.commands.executeCommand("autograder.openInEditor", m.pk);
      case "output": return this.loadOutput(m.pk, m.cmdPk, m.key);
      case "setupOutput": return this.loadSetupOutput(m.pk, m.suitePk, m.key);
      case "openDiff": return this.openDiff(m.pk, m.cmdPk, m.stream);
      case "open": {
        const loc = this.links.get(m.link);
        if (!loc) return;
        const pos = new vscode.Position(Math.max(0, loc.line - 1), Math.max(0, loc.column - 1));
        await vscode.window.showTextDocument(loc.uri, { viewColumn: this.otherColumn(), selection: new vscode.Range(pos, pos) });
        return;
      }
      case "problems": return this.showProblems(m.pk);
      case "compare": return this.compare(m.pk);
      case "checkout": return this.checkout(m.pk);
      case "copySha": {
        const s = this.snapshots.get(m.pk);
        if (s) { await vscode.env.clipboard.writeText(s.sha); void vscode.window.showInformationMessage(`Copied ${s.short}`); }
        return;
      }
    }
  }

  /** Keep the results visible: from an editor tab, open things in the other column. */
  private otherColumn(): vscode.ViewColumn {
    const own = this.host.column();
    return own === undefined ? vscode.ViewColumn.Active
      : own === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
  }

  private async loadOutput(pk: number, cmdPk: number, key: string) {
    const sub = this.submissions.find((s) => s.pk === pk)!;
    const resolver = this.resolverFor(sub);
    const client = this.conn!.client;
    const cmd = this.findCommand(pk, cmdPk)?.cmd;
    // Tests graded against an expected output (e.g. EECS 280's .correct files) also get the diff.
    const diff = (stream: "stdout" | "stderr") => cmd && hasDiff(cmd, stream)
      ? client.commandDiff(sub, cmdPk, stream).then((d) => d && buildView(d)).catch(() => null) : null;
    const [stdout, stderr, stdoutDiff, stderrDiff] = await Promise.all([
      client.commandOutput(sub, cmdPk, "stdout").catch(() => ""),
      client.commandOutput(sub, cmdPk, "stderr").catch(() => ""),
      diff("stdout"), diff("stderr"),
    ]);
    this.post({
      type: "output", key,
      stdout: await segmentOutput(stdout, resolver, this.links),
      stderr: await segmentOutput(stderr, resolver, this.links),
      diffs: { stdout: stdoutDiff, stderr: stderrDiff },
    });
  }

  private findCommand(pk: number, cmdPk: number): { testName: string; cmd: CommandResult } | undefined {
    for (const suite of this.results.get(pk)?.ag_test_suite_results ?? []) {
      for (const c of suite.ag_test_case_results) {
        const cmd = c.ag_test_command_results.find((x) => x.pk === cmdPk);
        if (cmd) return { cmd, testName: c.ag_test_command_results.length > 1 ? `${c.ag_test_case_name} › ${cmd.ag_test_command_name}` : c.ag_test_case_name };
      }
    }
    return undefined;
  }

  /** Expected output vs. your real output in VS Code's diff editor. */
  private async openDiff(pk: number, cmdPk: number, stream: "stdout" | "stderr") {
    const sub = this.submissions.find((s) => s.pk === pk);
    const found = this.findCommand(pk, cmdPk);
    if (!sub || !found || !this.conn) return;
    const [diff, actual] = await Promise.all([
      this.conn.client.commandDiff(sub, cmdPk, stream),
      this.conn.client.commandOutput(sub, cmdPk, stream),
    ]);
    if (!diff) { void vscode.window.showInformationMessage("autograder.io doesn't show the expected output for this test."); return; }
    // A match may come back as [], which carries no expected text to rebuild.
    if (!diff.length) { void vscode.window.showInformationMessage("Your output matches the expected output."); return; }
    // Expected is rebuilt from the diff; "yours" is the real output, so the editor shows it byte-for-byte.
    const name = found.testName.replace(/[^\w.-]+/g, "_");
    const left = OutputDocs.put(`submission-${pk}/${name}.expected-${stream}.txt`, expectedText(diff));
    const right = OutputDocs.put(`submission-${pk}/${name}.your-${stream}.txt`, actual);
    await vscode.commands.executeCommand("vscode.diff", left, right,
      `${found.testName}: Expected ↔ Yours (#${pk} ${stream})`, { preview: true, viewColumn: this.otherColumn() });
  }

  private async loadSetupOutput(pk: number, suitePk: number, key: string) {
    const sub = this.submissions.find((s) => s.pk === pk)!;
    const resolver = this.resolverFor(sub);
    const [stdout, stderr] = await Promise.all([
      this.conn!.client.suiteSetupOutput(sub, suitePk, "stdout").catch(() => ""),
      this.conn!.client.suiteSetupOutput(sub, suitePk, "stderr").catch(() => ""),
    ]);
    this.post({
      type: "output", key,
      stdout: await segmentOutput(stdout, resolver, this.links),
      stderr: await segmentOutput(stderr, resolver, this.links),
    });
  }

  async showProblems(pk: number) {
    this.conn ??= await this.deps.connect(true);
    if (!this.conn) return;
    // Only ever submissions of your own group (as listed by groups_is_member_of): never fetch one by
    // id, which a staff token would allow for any student's.
    let sub = this.submissions.find((s) => s.pk === pk);
    if (!sub) {
      await this.refresh(pk);   // a just-made submission may not be listed yet
      sub = this.submissions.find((s) => s.pk === pk);
    }
    if (!sub || !this.conn) return;
    let res = this.results.get(pk);
    res ??= await this.conn.client.results(sub);
    this.results.set(pk, res);
    const n = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Reading test output for #${pk}…`, cancellable: true },
      (_p, token) => publishProblems(this.deps.diagnostics, this.conn!.client, sub, res, this.resolverFor(sub), token));
    if (n) await vscode.commands.executeCommand("workbench.actions.view.problems");
    else void vscode.window.showInformationMessage("No file/line references found in the visible output of failing tests.");
  }

  // ---- git ------------------------------------------------------------------

  private async compare(pk: number) {
    const snap = this.snapshots.get(pk);
    if (!snap || !this.repoRoot) return;
    const changes = await git.changedFiles(this.repoRoot, snap.sha);
    if (!changes.length) {
      void vscode.window.showInformationMessage(`Your files match submission #${pk}'s snapshot.`);
      return;
    }
    const gitApi = vscode.extensions.getExtension<any>("vscode.git")?.exports?.getAPI(1);
    if (!gitApi) { void vscode.window.showErrorMessage("The built-in Git extension is disabled."); return; }
    const resources = changes.map((c) => {
      const uri = vscode.Uri.file(path.join(this.repoRoot!, c.path));
      return [uri, c.status === "A" ? undefined : gitApi.toGitUri(uri, snap.sha), c.status === "D" ? undefined : uri];
    });
    await vscode.commands.executeCommand("vscode.changes",
      `Submission #${pk} (${snap.short}${snap.kind === "approx" ? ", approx." : ""}) ↔ Working Tree`, resources);
  }

  private async checkout(pk: number) {
    const snap = this.snapshots.get(pk);
    if (!snap || !this.repoRoot) return;
    if (await git.isDirty(this.repoRoot)) {
      void vscode.window.showWarningMessage("Commit or stash your current changes first, so nothing gets overwritten.");
      return;
    }
    let name = `autograder/submission-${pk}`;
    const chosen = await vscode.window.showInputBox({
      title: `Create a branch at submission #${pk}'s code`,
      value: name,
      prompt: snap.kind === "approx" ? "Note: this commit is inferred from the submission time." : undefined,
      validateInput: async (v) => (await git.branchExists(this.repoRoot!, v) ? "Branch already exists" : undefined),
    });
    if (!chosen) return;
    name = chosen;
    await git.createBranchAt(this.repoRoot, name, snap.sha);
    void vscode.window.showInformationMessage(`Switched to new branch ${name}. Use the branch picker to go back.`);
  }

  // ---- html -----------------------------------------------------------------

  private html(): string {
    const w = this.host.webview;
    const media = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.deps.extensionUri, "media", f));
    const nonce = Array.from({ length: 24 }, () => Math.random().toString(36)[2]).join("");
    return /* html */ `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}'; font-src ${w.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media("panel.css")}">
<title>Autograder</title>
</head><body>
<div id="app"><div class="empty">Loading…</div></div>
<script nonce="${nonce}" src="${media("panel.js")}"></script>
</body></html>`;
  }
}

/** Read-only in-memory documents for the diff editor (expected / actual test output). */
export class OutputDocs implements vscode.TextDocumentContentProvider {
  static readonly scheme = "autograder-output";
  private static docs = new Map<string, string>();
  private static changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = OutputDocs.changed.event;

  static put(name: string, text: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: OutputDocs.scheme, path: "/" + name });
    OutputDocs.docs.set(uri.path, text);   // keyed by the decoded path, which survives VS Code's URI round-trip
    OutputDocs.changed.fire(uri);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string { return OutputDocs.docs.get(uri.path) ?? ""; }

  static register(): vscode.Disposable {
    return vscode.workspace.registerTextDocumentContentProvider(OutputDocs.scheme, new OutputDocs());
  }
}

function scoreOf(r: SubmissionResults) {
  return { points: Number(r.total_points), possible: Number(r.total_points_possible) };
}
