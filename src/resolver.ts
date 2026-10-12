import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { execFile } from "child_process";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { AutograderClient, Submission } from "./api";
import { FileRef, candidatePaths, isNoise, looksBundled, normalizeSourceMapSource } from "./linkParser";

export interface ResolvedRef {
  uri: vscode.Uri;
  line: number;      // 1-based
  column: number;    // 1-based
  /** e.g. "via submitted bundle.js.map" */
  note?: string;
}

const ARCHIVE = /\.(tar\.gz|tgz|tar|zip)$/i;

/**
 * Resolves output refs to workspace files. One instance per (workspace, submission) so the
 * source maps extracted from that submission's own tarball are used — the local bundle may
 * have been rebuilt since.
 */
export class RefResolver {
  private fileIndex?: Promise<Map<string, vscode.Uri[]>>;
  private maps = new Map<string, Promise<TraceMap | undefined>>();
  private extracted?: Promise<string | undefined>;

  constructor(
    private root: vscode.Uri,
    private client: AutograderClient,
    private submission: Submission,
    private cacheDir: vscode.Uri,
  ) {}

  async resolve(ref: FileRef): Promise<ResolvedRef | undefined> {
    if (isNoise(ref.rawPath)) return undefined;
    if (looksBundled(ref.rawPath)) {
      const viaMap = await this.resolveViaSourceMap(ref);
      // With a map, frames that land in library code (or nowhere) aren't yours: don't link the bundle.
      if (viaMap !== "no-map") return viaMap;
    }
    const uri = await this.findInWorkspace(ref.rawPath);
    return uri ? { uri, line: ref.line, column: ref.column ?? 1 } : undefined;
  }

  // ---- plain paths -------------------------------------------------------

  private buildIndex(): Promise<Map<string, vscode.Uri[]>> {
    return (this.fileIndex ??= (async () => {
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(this.root, "**/*"),
        "{**/node_modules/**,**/.git/**,**/env/**,**/.venv/**,**/__pycache__/**}", 20000);
      const byName = new Map<string, vscode.Uri[]>();
      for (const f of files) {
        const name = path.posix.basename(f.path);
        (byName.get(name) ?? byName.set(name, []).get(name)!).push(f);
      }
      return byName;
    })());
  }

  async findInWorkspace(rawPath: string): Promise<vscode.Uri | undefined> {
    const cands = candidatePaths(rawPath);
    if (!cands.length) return undefined;
    for (const rel of cands.slice(0, -1)) {   // multi-segment candidates: direct hit?
      const uri = vscode.Uri.joinPath(this.root, rel);
      if (await exists(uri)) return uri;
    }
    // Fall back to basename, preferring the longest matching path suffix.
    const index = await this.buildIndex();
    const hits = index.get(cands[cands.length - 1]) ?? [];
    if (hits.length <= 1) return hits[0];
    const norm = rawPath.replace(/\\/g, "/");
    return hits
      .map((u) => ({ u, score: commonSuffixSegments(norm, u.path) }))
      .sort((a, b) => b.score - a.score)[0].u;
  }

  // ---- source maps -------------------------------------------------------

  private async resolveViaSourceMap(ref: FileRef): Promise<ResolvedRef | undefined | "no-map"> {
    const found = await this.findMapFile(ref.rawPath);
    if (!found) return "no-map";
    let mp = this.maps.get(found.file);
    if (!mp) {
      mp = fs.readFile(found.file, "utf8").then((t) => new TraceMap(t)).catch(() => undefined);
      this.maps.set(found.file, mp);
    }
    const map = await mp;
    if (!map) return "no-map";
    // Stack columns are 1-based; trace-mapping wants 0-based columns, 1-based lines.
    const pos = originalPositionFor(map, { line: ref.line, column: Math.max(0, (ref.column ?? 1) - 1) });
    if (!pos.source || pos.line == null) return undefined;
    // Relative sources ("../../js/main.jsx", esbuild/rollup style) are relative to the map file.
    const source = /^\.\.?\//.test(pos.source) && found.base
      ? path.posix.normalize(path.posix.join(path.relative(found.base, path.dirname(found.file)).split(path.sep).join("/"), pos.source))
      : normalizeSourceMapSource(pos.source);
    if (isNoise(source)) return undefined;   // React internals etc. — not your code
    const uri = await this.findInWorkspace(source);
    if (!uri) return undefined;
    return { uri, line: pos.line, column: (pos.column ?? 0) + 1, note: found.note };
  }

  /** Prefer the .map inside this submission's own archive; fall back to the workspace copy. */
  private async findMapFile(rawPath: string): Promise<{ file: string; note: string; base?: string } | undefined> {
    const wanted = path.posix.basename(rawPath) + ".map";
    const dir = await this.extractSubmission();
    if (dir) {
      const maps = (await walk(dir)).filter((f) => path.basename(f) === wanted);
      const best = maps.sort((a, b) => commonSuffixSegments(rawPath + ".map", b) - commonSuffixSegments(rawPath + ".map", a))[0];
      if (best) {
        // Archives extract to "<name>.d/"; that's the root relative map paths are measured from.
        const base = best.slice(0, best.indexOf(".d" + path.sep) + 2) || dir;
        return { file: best, note: `mapped with ${wanted} from submission #${this.submission.pk}`, base };
      }
    }
    const local = await this.findInWorkspace(rawPath + ".map");
    if (local) return { file: local.fsPath, note: `mapped with local ${wanted} (may differ from what you submitted)`, base: this.root.fsPath };
    return undefined;
  }

  private extractSubmission(): Promise<string | undefined> {
    return (this.extracted ??= (async () => {
      const dir = vscode.Uri.joinPath(this.cacheDir, "submissions", String(this.submission.pk), "files").fsPath;
      const marker = path.join(dir, ".complete");
      if (await exists(vscode.Uri.file(marker))) return dir;
      await fs.mkdir(dir, { recursive: true });
      for (const name of this.submission.submitted_filenames) {
        const safe = path.basename(name);
        const data = await this.client.submittedFile(this.submission.pk, name);
        const file = path.join(dir, safe);
        await fs.writeFile(file, data);
        if (ARCHIVE.test(safe)) {
          const out = path.join(dir, safe + ".d");
          await fs.mkdir(out, { recursive: true });
          await run("tar", ["-xf", file, "-C", out]).catch(() => undefined);
        }
      }
      await fs.writeFile(marker, "");
      return dir;
    })().catch(() => undefined));
  }
}

function commonSuffixSegments(a: string, b: string): number {
  const x = a.split("/").reverse(), y = b.split("/").reverse();
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try { return (await vscode.workspace.fs.stat(uri)).type === vscode.FileType.File; } catch { return false; }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p)); else out.push(p);
  }
  return out;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => execFile(cmd, args, (err) => err ? rej(err) : res()));
}
