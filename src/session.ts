import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { AutograderClient, ApiError, User } from "./api";

const SECRET_KEY = "autograder.apiToken";

export function baseUrl(): string {
  return vscode.workspace.getConfiguration("autograder").get<string>("baseUrl") || "https://autograder.io";
}

/**
 * Holds the API token (in VS Code SecretStorage, i.e. the OS keychain) and the signed-in user.
 * autograder.io uses Google SSO, which can't run inside VS Code, so we use the personal API
 * token the site exposes at /web/__apitoken__ — the same mechanism the official CLI tools use.
 */
export class Session {
  private user?: User;
  private client?: AutograderClient;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private secrets: vscode.SecretStorage) {
    secrets.onDidChange((e) => {
      if (e.key === SECRET_KEY) { this.user = undefined; this.client = undefined; this.changed.fire(); }
    });
  }

  /** Returns a client, prompting to sign in if needed. Undefined if the user cancels. */
  async ensureClient(interactive = true): Promise<{ client: AutograderClient; user: User } | undefined> {
    if (this.client && this.user) return { client: this.client, user: this.user };
    // AUTOGRADER_TOKEN lets scripted/demo setups skip the paste-a-token step.
    const token = await this.secrets.get(SECRET_KEY) ?? process.env.AUTOGRADER_TOKEN;
    if (token) {
      const client = new AutograderClient(baseUrl(), token);
      try {
        this.user = await client.currentUser();
        this.client = client;
        return { client, user: this.user };
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) throw e;
        await this.secrets.delete(SECRET_KEY);
        void vscode.window.showWarningMessage("Your autograder.io token was rejected. Please sign in again.");
      }
    }
    if (!interactive) return undefined;
    return (await this.signIn()) ? this.ensureClient(false) : undefined;
  }

  async signIn(): Promise<boolean> {
    // The ag-contrib CLI stores its token in ~/.agtoken; offer to reuse it.
    const agtokenPath = path.join(os.homedir(), ".agtoken");
    const agtoken = (await fs.readFile(agtokenPath, "utf8").catch(() => "")).trim();
    if (agtoken) {
      const pick = await vscode.window.showInformationMessage(
        "Found an autograder.io token in ~/.agtoken. Use it?", "Use ~/.agtoken", "Get a new token");
      if (pick === "Use ~/.agtoken" && await this.tryToken(agtoken)) return true;
      if (!pick) return false;
    }

    const url = `${baseUrl()}/web/__apitoken__`;
    const open = await vscode.window.showInformationMessage(
      "Sign in to autograder.io in your browser, copy your API token from the page that opens, then paste it here.",
      { modal: true }, "Open token page", "I already have it");
    if (!open) return false;
    if (open === "Open token page") await vscode.env.openExternal(vscode.Uri.parse(url));

    const token = await vscode.window.showInputBox({
      title: "autograder.io API token",
      prompt: `Paste the token shown at ${url}`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (/^[0-9a-f]{20,}$/i.test(v.trim()) ? undefined : "That doesn't look like an API token"),
    });
    if (!token) return false;
    return this.tryToken(token.trim());
  }

  private async tryToken(token: string): Promise<boolean> {
    try {
      const user = await new AutograderClient(baseUrl(), token).currentUser();
      await this.secrets.store(SECRET_KEY, token);
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
