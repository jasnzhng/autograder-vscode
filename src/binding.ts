import * as vscode from "vscode";
import { AutograderClient, User } from "./api";

const PROJECT_URL = /autograder\.io\/web\/project\/(\d+)/;

export function workspaceRoot(): vscode.WorkspaceFolder | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  return (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
}

export function cfg(folder?: vscode.WorkspaceFolder) {
  return vscode.workspace.getConfiguration("autograder", folder?.uri);
}

/**
 * Students' own helper scripts and READMEs often contain the project URL (e.g. a hand-written
 * `makesubmit` with `AUTOGRADER="https://autograder.io/web/project/1234"`). Look there before asking.
 */
export async function detectProjectId(folder: vscode.WorkspaceFolder): Promise<{ id: number; from: string } | undefined> {
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, "{makesubmit,Makefile,makefile,*.sh,bin/*,README*,*.md,.vscode/autograder.json}"),
    "**/node_modules/**", 50);
  // Scripts first: they're the most specific signal.
  files.sort((a, b) => rank(a.path) - rank(b.path));
  for (const f of files) {
    try {
      const bytes = await vscode.workspace.fs.readFile(f);
      if (bytes.byteLength > 512 * 1024) continue;
      const m = Buffer.from(bytes).toString("utf8").match(PROJECT_URL);
      if (m) return { id: Number(m[1]), from: vscode.workspace.asRelativePath(f) };
    } catch { /* unreadable */ }
  }
  return undefined;
}

function rank(p: string): number {
  if (/makesubmit$/.test(p)) return 0;
  if (/[Mm]akefile$/.test(p)) return 1;
  if (/\.sh$|\/bin\//.test(p)) return 2;
  return 3;
}

/** Returns the bound project id, detecting and persisting it on first use. */
export async function resolveProjectId(folder: vscode.WorkspaceFolder, client: AutograderClient, user: User,
                                       opts: { interactive: boolean }): Promise<number | undefined> {
  const configured = cfg(folder).get<number | null>("projectId");
  if (configured) return configured;
  const detected = await detectProjectId(folder);
  if (detected) {
    // Only write settings when the user is actively doing something, not on passive startup.
    if (!opts.interactive) return detected.id;
    await cfg(folder).update("projectId", detected.id, vscode.ConfigurationTarget.WorkspaceFolder);
    void vscode.window.showInformationMessage(
      `Autograder: linked this workspace to project ${detected.id} (found in ${detected.from}).`);
    return detected.id;
  }
  return opts.interactive ? pickProject(folder, client, user) : undefined;
}

export async function pickProject(folder: vscode.WorkspaceFolder, client: AutograderClient, user: User): Promise<number | undefined> {
  const courses = await client.coursesEnrolled(user.pk);
  // Newest terms first.
  const termOrder: Record<string, number> = { Winter: 0, Spring: 1, Summer: 2, Fall: 3 };
  courses.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || (termOrder[b.semester ?? ""] ?? 0) - (termOrder[a.semester ?? ""] ?? 0));
  const course = await vscode.window.showQuickPick(
    courses.map((c) => ({ label: c.name, description: [c.semester, c.year].filter(Boolean).join(" "), c })),
    { title: "Autograder: choose a course" });
  if (!course) return undefined;
  const projects = await client.projects(course.c.pk);
  const project = await vscode.window.showQuickPick(
    projects.map((p) => ({ label: p.name, description: `#${p.pk}`, p })),
    { title: `Autograder: choose a ${course.c.name} project` });
  if (!project) return undefined;
  await cfg(folder).update("projectId", project.p.pk, vscode.ConfigurationTarget.WorkspaceFolder);
  return project.p.pk;
}

let devMode = false;
export function setDevMode(v: boolean) { devMode = v; }

/** Dry run if explicitly enabled — or, when unset, whenever this is a development build. */
export function isDryRun(folder?: vscode.WorkspaceFolder): boolean {
  const i = cfg(folder).inspect<boolean>("dryRun");
  const explicit = i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue;
  return explicit ?? devMode;
}
