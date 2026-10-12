// autograder.io's /web/__apitoken__ page doesn't display the token: it downloads it as a file
// named "agtoken" (see ag-website-vue src/components/api_token.vue). The official CLI expects it
// saved as ~/.agtoken. Pure helpers (no vscode import) so they can be unit-tested.
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
