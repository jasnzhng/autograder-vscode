import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { AutograderClient, ApiError, User } from "./api";
import {
  DEFAULT_SERVER, findDownloadedToken, parseStoredToken, parseToken, readTokenFile, serverOrigin, StoredToken, TokenFile,
} from "./tokenFile";

const SECRET_KEY = "autograder.apiToken";
const DOWNLOADS = path.join(os.homedir(), "Downloads");
const tilde = (p: string) => p.startsWith(os.homedir()) ? "~" + p.slice(os.homedir().length) : p;

/**
 * Before sending the user to a server other than autograder.io (its pages could be a fake sign-in),
 * make sure they meant it: autograder.baseUrl can come from a project's .vscode/settings.json.
 */
export async function confirmServer(origin: string, detail: string): Promise<boolean> {
  if (origin === DEFAULT_SERVER) return true;
  const go = await vscode.window.showWarningMessage(
    `This workspace points Autograder at ${origin}, not autograder.io.`,
    { modal: true, detail: `${detail} Only continue if you set autograder.baseUrl yourself.` }, "Continue");
  return go === "Continue";
}

/** The configured server's origin. Throws unless it's https (or http on localhost). */
export function baseUrl(): string {
  const raw = vscode.workspace.getConfiguration("autograder").get<string>("baseUrl");
  const origin = serverOrigin(raw);
  if (!origin) throw new Error(`autograder.baseUrl must be an https:// URL (it's set to "${raw}").`);
  return origin;
}

/**
 * Holds the API token (in VS Code SecretStorage, i.e. the OS keychain) and the signed-in user.
 * autograder.io uses Google SSO, which can't run inside VS Code, so we use the personal API
 * token the site hands out at /web/__apitoken__ as a downloaded "agtoken" file — the same
 * token the official CLI reads from ~/.agtoken.
 */
export class Session {
  private user?: User;
  private client?: AutograderClient;
  private origin?: string;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private secrets: vscode.SecretStorage) {
    secrets.onDidChange((e) => {
      if (e.key === SECRET_KEY) { this.user = undefined; this.client = undefined; this.changed.fire(); }
    });
  }

  /** Returns a client, prompting to sign in if needed. Undefined if the user cancels. */
  async ensureClient(interactive = true): Promise<{ client: AutograderClient; user: User } | undefined> {
    let origin: string;
    try { origin = baseUrl(); } catch (e) {
      if (interactive) void vscode.window.showErrorMessage(`Autograder: ${(e as Error).message}`);
      return undefined;
    }
    if (this.client && this.user && this.origin === origin) return { client: this.client, user: this.user };
    // A token only ever goes back to the server that issued it, so a workspace's .vscode/settings.json
    // can't redirect it by changing autograder.baseUrl: pointed elsewhere, you're just signed out.
    const stored = parseStoredToken(await this.secrets.get(SECRET_KEY));
    // AUTOGRADER_TOKEN lets scripted/demo setups skip the paste-a-token step.
    const token = stored?.origin === origin ? stored.token : process.env.AUTOGRADER_TOKEN;
    if (token) {
      const client = new AutograderClient(origin, token);
      try {
        this.user = await client.currentUser();
        this.client = client;
        this.origin = origin;
        return { client, user: this.user };
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) throw e;
        if (token === stored?.token) await this.secrets.delete(SECRET_KEY);
        void vscode.window.showWarningMessage("Your autograder.io token was rejected. Please sign in again.");
      }
    }
    if (!interactive) return undefined;
    return (await this.signIn()) ? this.ensureClient(false) : undefined;
  }

  async signIn(): Promise<boolean> {
    let origin: string;
    try { origin = baseUrl(); } catch (e) {
      void vscode.window.showErrorMessage(`Autograder: ${(e as Error).message}`);
      return false;
    }
    // Signing in hands the token to this server, and its token page is where you type your password.
    if (!(await confirmServer(origin, "Signing in sends your API token to that server, and its sign-in page could ask " +
      "for your university password."))) return false;

    // 1. Reuse a token file that's already on disk.
    const existing = await this.findExistingToken();
    if (existing) {
      const pick = await vscode.window.showInformationMessage(
        `Found an autograder.io token in ${tilde(existing.file)}. Use it?`, "Use it", "Get a new token");
      if (pick === "Use it" && await this.tryToken(existing.token, origin)) {
        await this.tidyDownloadedFile(existing.file);
        return true;
      }
      if (!pick) return false;
    }

    // 2. The token page downloads the token as a file named "agtoken"; watch for it.
    const url = `${origin}/web/__apitoken__`;
    const choice = await vscode.window.showInformationMessage(
      "Sign in to autograder.io",
      { modal: true, detail: "Your browser will open autograder.io's token page. After you sign in, it downloads " +
        "a small file named \"agtoken\". VS Code picks it up from your Downloads folder automatically." },
      "Open token page", "Choose token file…", "Paste token…");
    if (!choice) return false;
    if (choice === "Choose token file…") return this.chooseTokenFile(origin);
    if (choice === "Paste token…") return this.pasteToken(origin);

    const started = Date.now();
    await vscode.env.openExternal(vscode.Uri.parse(url));
    const found = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, cancellable: true,
        title: "Waiting for the agtoken download from autograder.io…" },
      async (_p, cancel) => {
        // Give slow sign-ins (Duo, account picker) a few minutes.
        while (!cancel.isCancellationRequested && Date.now() - started < 5 * 60 * 1000) {
          const hit = await findDownloadedToken(DOWNLOADS, started - 2000);
          if (hit) return hit;
          await new Promise((r) => setTimeout(r, 1000));
        }
        return undefined;
      });
    if (found) {
      if (!(await this.tryToken(found.token, origin))) return false;
      await this.tidyDownloadedFile(found.file);
      return true;
    }
    // Saved somewhere else, or the browser asked where to save it.
    const next = await vscode.window.showWarningMessage(
      "Didn't see an agtoken file in your Downloads folder.", "Choose token file…", "Paste token…");
    if (next === "Choose token file…") return this.chooseTokenFile(origin);
    if (next === "Paste token…") return this.pasteToken(origin);
    return false;
  }

  private async findExistingToken(): Promise<TokenFile | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const file of [path.join(os.homedir(), ".agtoken"), ...folders.map((f) => path.join(f.uri.fsPath, ".agtoken"))]) {
      const t = await readTokenFile(file);
      if (t) return t;
    }
    return findDownloadedToken(DOWNLOADS);
  }

  private async chooseTokenFile(origin: string): Promise<boolean> {
    const picked = await vscode.window.showOpenDialog({
      title: "Choose the agtoken file downloaded from autograder.io",
      defaultUri: vscode.Uri.file(DOWNLOADS), canSelectMany: false, openLabel: "Use this token",
    });
    if (!picked?.[0]) return false;
    const t = await readTokenFile(picked[0].fsPath);
    if (!t) {
      void vscode.window.showErrorMessage("That file doesn't contain an autograder.io token.");
      return false;
    }
    if (!(await this.tryToken(t.token, origin))) return false;
    await this.tidyDownloadedFile(t.file);
    return true;
  }

  private async pasteToken(origin: string): Promise<boolean> {
    const token = await vscode.window.showInputBox({
      title: "autograder.io API token",
      prompt: "Paste the contents of the agtoken file",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (parseToken(v) ? undefined : "That doesn't look like an API token"),
    });
    const parsed = token && parseToken(token);
    return parsed ? this.tryToken(parsed, origin) : false;
  }

  /** The downloaded file is a credential in plain text: offer to delete it or keep it as ~/.agtoken (CLI convention). */
  private async tidyDownloadedFile(file: string): Promise<void> {
    if (path.dirname(file) !== DOWNLOADS) return;
    const home = path.join(os.homedir(), ".agtoken");
    const homeExists = await fs.stat(home).then(() => true, () => false);
    const actions = homeExists ? ["Delete it", "Keep it"] : ["Delete it", "Move to ~/.agtoken", "Keep it"];
    const pick = await vscode.window.showInformationMessage(
      `${tilde(file)} contains your autograder.io token in plain text. VS Code has stored it securely.`, ...actions);
    try {
      if (pick === "Delete it") await fs.rm(file);
      if (pick === "Move to ~/.agtoken") { await fs.rename(file, home); await fs.chmod(home, 0o600); }
    } catch (e) {
      void vscode.window.showWarningMessage(`Couldn't update ${tilde(file)}: ${(e as Error).message}`);
    }
  }

  private async tryToken(token: string, origin: string): Promise<boolean> {
    try {
      const user = await new AutograderClient(origin, token).currentUser();
      const stored: StoredToken = { token, origin };
      await this.secrets.store(SECRET_KEY, JSON.stringify(stored));
      void vscode.window.showInformationMessage(`Signed in to autograder.io as ${user.username}.`);
      return true;
    } catch (e) {
      void vscode.window.showErrorMessage(`That token didn't work: ${(e as Error).message}`);
      return false;
    }
  }

  async signOut(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
    // autograder.io keeps ONE token per user and the website session uses it too, so revoking
    // it would also log the browser out. Signing out here just forgets it locally.
    void vscode.window.showInformationMessage("Signed out of autograder.io in VS Code.");
  }
}
