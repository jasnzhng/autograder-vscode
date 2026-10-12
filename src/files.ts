// Pure helpers for choosing which files to upload. No vscode import (unit-tested).

/** Python fnmatch semantics (what autograder uses for expected_student_files patterns). */
export function fnmatchToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const close = pattern.indexOf("]", i + 2);
      if (close === -1) { re += "\\["; continue; }
      let body = pattern.slice(i + 1, close);
      if (body.startsWith("!")) body = "^" + body.slice(1);
      re += "[" + body.replace(/\\/g, "\\\\") + "]";
      i = close;
    } else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

export interface PatternMatch {
  pattern: string;
  min: number;
  max: number;
  /** Workspace-relative paths whose basename matches, best candidates first. */
  matches: string[];
}

/**
 * Match workspace files to the project's expected patterns. Autograder flattens uploads to
 * basenames, so we compare basenames and prefer shallower paths (root `submit.tar.gz` over
 * some copy in a subfolder).
 */
export function matchExpected(relPaths: string[], expected: Array<{ pattern: string; min_num_matches: number; max_num_matches: number }>): PatternMatch[] {
  return expected.map((e) => {
    const re = fnmatchToRegExp(e.pattern);
    const matches = relPaths
      .filter((p) => re.test(p.split("/").pop()!))
      .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    return { pattern: e.pattern, min: e.min_num_matches, max: e.max_num_matches, matches };
  });
}

/** Choose files: per pattern take up to `max` shallowest matches, dropping basename duplicates. */
export function chooseUploads(results: PatternMatch[]): { files: string[]; problems: string[] } {
  const files: string[] = [];
  const names = new Set<string>();
  const problems: string[] = [];
  for (const r of results) {
    const picked: string[] = [];
    for (const m of r.matches) {
      const name = m.split("/").pop()!;
      if (names.has(name) || picked.length >= r.max) continue;
      names.add(name);
      picked.push(m);
    }
    if (picked.length < r.min) problems.push(`No file matching "${r.pattern}" (need at least ${r.min}).`);
    files.push(...picked);
  }
  return { files, problems };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const ARCHIVE_RE = /\.(tar\.gz|tgz|tar|tar\.bz2|tbz2|tar\.xz|txz|zip)$/i;

/** True when every expected pattern is an archive, e.g. a single `submit.tar.gz`. */
export function isArchiveProject(expected: Array<{ pattern: string }>): boolean {
  return expected.length > 0 && expected.every((e) => ARCHIVE_RE.test(e.pattern));
}

/** Drop paths already covered by a selected ancestor directory ("src" covers "src/js/x.jsx"). */
export function pruneNested(paths: string[]): string[] {
  const clean = [...new Set(paths.map((p) => p.replace(/\/+$/, "")).filter(Boolean))].sort();
  return clean.filter((p) => !clean.some((q) => q !== p && p.startsWith(q + "/")));
}

export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The archive command we generate when the user picks contents instead of pasting the spec's. */
export function buildArchiveCommand(archive: string, paths: string[], platform: string): string {
  const items = pruneNested(paths).map(shellQuote).join(" ");
  if (/\.zip$/i.test(archive)) {
    return `rm -f ${shellQuote(archive)} && zip -r ${shellQuote(archive)} ${items} -x '*__pycache__*' '*.DS_Store'`;
  }
  const flag = /\.(tar\.gz|tgz)$/i.test(archive) ? "z" : /\.(tar\.bz2|tbz2)$/i.test(archive) ? "j" : /\.(tar\.xz|txz)$/i.test(archive) ? "J" : "";
  // macOS tar otherwise adds ._AppleDouble files that autograders choke on.
  const env = platform === "darwin" ? "COPYFILE_DISABLE=1 " : "";
  return `${env}tar -c${flag}f ${shellQuote(archive)} --exclude='*__pycache__*' --exclude='.DS_Store' ${items}`;
}

/**
 * Reconstruct what was passed to `tar` from an existing archive's listing (`tar -tf`).
 * tar lists "dir/" when a directory was added, but not the parents of individually added files.
 */
export function inferArchiveRoots(entries: string[]): string[] {
  const norm = entries.map((e) => e.replace(/^\.\//, "")).filter((e) => e && !/(^|\/)\._/.test(e));
  const dirs = new Set(norm.filter((e) => e.endsWith("/")).map((e) => e.slice(0, -1)));
  const files = norm.filter((e) => !e.endsWith("/"));
  const roots = [...dirs, ...files.filter((f) => ![...dirs].some((d) => f.startsWith(d + "/")))];
  return pruneNested(roots);
}

/** Tidy a command pasted from a spec: drop "$ " prompts and join backslash-continued lines. */
export function normalizePastedCommand(cmd: string): string {
  return cmd.replace(/\\\s*\r?\n\s*/g, " ").split(/\r?\n/).map((l) => l.trim().replace(/^\$\s+/, "")).filter(Boolean).join(" && ").replace(/\s+/g, " ").trim();
}
