// autograder.io's /web/__apitoken__ page doesn't display the token: it downloads it as a file
// named "agtoken" (see ag-website-vue src/components/api_token.vue). The official CLI expects it
// saved as ~/.agtoken. Pure helpers (no vscode import) so they can be unit-tested.
// Also: which server a token may be sent to, and how it's stored.
import * as fs from "fs/promises";
import * as path from "path";

/** "agtoken", plus the names browsers give repeat downloads: "agtoken (1)", "agtoken-2", "agtoken.txt". */
export function isDownloadedTokenName(name: string): boolean {
  return /^agtoken(\s*\(\d+\)|-\d+)?(\.txt)?$/i.test(name);
}

/** The file holds just the token; tolerate whitespace and surrounding quotes. */
export function parseToken(contents: string): string | undefined {
  const t = contents.trim().replace(/^["']|["']$/g, "");
  return /^[0-9a-f]{20,64}$/i.test(t) ? t : undefined;
}

export const DEFAULT_SERVER = "https://autograder.io";

/**
 * The origin a token may be sent to, from the `autograder.baseUrl` setting: https only, or plain
 * http on this machine (the demo's mock server). Undefined for anything else.
 */
export function serverOrigin(raw: string | undefined): string | undefined {
  let u: URL;
  try { u = new URL(raw || DEFAULT_SERVER); } catch { return undefined; }
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return undefined;
  if (u.username || u.password) return undefined;
  return u.origin;
}

/** What's kept in SecretStorage: the token plus the origin it was issued by. */
export interface StoredToken { token: string; origin: string }

export function parseStoredToken(raw: string | undefined): StoredToken | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    if (typeof v?.token === "string" && typeof v?.origin === "string") return { token: v.token, origin: v.origin };
  } catch { /* not JSON: an older bare token */ }
  // 0.1.x stored the bare token, and it could only have come from the default server.
  const token = parseToken(raw);
  return token ? { token, origin: DEFAULT_SERVER } : undefined;
}

export interface TokenFile { file: string; token: string; mtimeMs: number }

/** Newest downloaded `agtoken*` file in `dir` (modified at or after `sinceMs`, if given). */
export async function findDownloadedToken(dir: string, sinceMs = 0): Promise<TokenFile | undefined> {
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return undefined; }
  const candidates: TokenFile[] = [];
  for (const name of names.filter(isDownloadedTokenName)) {
    const file = path.join(dir, name);
    try {
      const st = await fs.stat(file);
      if (!st.isFile() || st.size > 1024 || st.mtimeMs < sinceMs) continue;
      const token = parseToken(await fs.readFile(file, "utf8"));
      if (token) candidates.push({ file, token, mtimeMs: st.mtimeMs });
    } catch { /* unreadable: skip */ }
  }
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
}

/** Read a specific token file such as ~/.agtoken. */
export async function readTokenFile(file: string): Promise<TokenFile | undefined> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > 1024) return undefined;
    const token = parseToken(await fs.readFile(file, "utf8"));
    return token ? { file, token, mtimeMs: st.mtimeMs } : undefined;
  } catch { return undefined; }
}
