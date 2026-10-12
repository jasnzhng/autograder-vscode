// Finds file:line references in autograder output. Pure (no vscode import) so it can be
// unit-tested with plain `node --test`.

export interface FileRef {
  /** Offset range of the clickable text within the input string. */
  start: number;
  end: number;
  /** Path exactly as printed (URLs are reduced to their pathname). */
  rawPath: string;
  line: number;          // 1-based
  column?: number;       // 1-based
}

const EXT = "(?:py|pyi|js|jsx|mjs|cjs|ts|tsx|c|cc|cpp|cxx|h|hh|hpp|hxx|java|rs|go|s|as|asm|sql|html|htm|css|sh|rb|kt|swift|ml)";

// Order matters: earlier patterns win when matches overlap.
const PATTERNS: RegExp[] = [
  // Python traceback:  File "/home/autograder/.../views/index.py", line 42, in show
  new RegExp(String.raw`File "([^"\n]+\.${EXT})", line (\d+)`, "g"),
  // URL stack frames (browser/webpack): http://localhost:3000/assets/app.js:1204:17
  new RegExp(String.raw`(https?://[^\s()'"]+?\.${EXT}):(\d+)(?::(\d+))?`, "g"),
  // Generic path:line[:col] — gcc/clang, pytest, eslint, node stacks, valgrind "(file.cpp:42)"
  new RegExp(String.raw`((?:[A-Za-z]:)?[\w.@~+\-/\\]*\.${EXT}):(\d+)(?::(\d+))?`, "g"),
  // MSVC / some tools: path(42) or path(42,7)
  new RegExp(String.raw`((?:[A-Za-z]:)?[\w.@~+\-/\\]*\.${EXT})\((\d+)(?:,(\d+))?\)`, "g"),
];

export function findFileRefs(text: string): FileRef[] {
  const refs: FileRef[] = [];
  const taken: Array<[number, number]> = [];
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);

  for (const re of PATTERNS) {
    re.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;
      let rawPath = m[1];
      if (/^https?:\/\//.test(rawPath)) {
        try { rawPath = new URL(rawPath).pathname; } catch { continue; }
      }
      const line = parseInt(m[2], 10);
      if (!line) continue;
      taken.push([start, end]);
      refs.push({ start, end, rawPath, line, column: m[3] ? parseInt(m[3], 10) : undefined });
    }
  }
  return refs.sort((a, b) => a.start - b.start);
}

/** Prefixes the autograder sandbox puts in front of student files. */
const SANDBOX_PREFIXES = [
  /^\/home\/autograder\/working_dir\/submit\//,
  /^\/home\/autograder\/working_dir\//,
  /^\/autograder\/working_dir\//,
  /^\/tmp\/[^/]+\/submit\//,
];

/** Ordered list of workspace-relative path candidates to try for a raw path. */
export function candidatePaths(rawPath: string): string[] {
  let p = rawPath.replace(/\\/g, "/");
  for (const re of SANDBOX_PREFIXES) p = p.replace(re, "");
  p = p.replace(/^\.\//, "").replace(/^\/+/, "");
  const parts = p.split("/").filter(Boolean);
  // "server/views/index.py" → itself, "views/index.py", "index.py"
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) out.push(parts.slice(i).join("/"));
  return out;
}

/** Paths we never want to link: toolchain/library internals. */
export function isNoise(rawPath: string): boolean {
  return /node_modules|site-packages|dist-packages|\/usr\/(lib|include)|<frozen|\/\.cache\//.test(rawPath);
}

/** Bundled outputs whose positions need a source map to be meaningful. */
export function looksBundled(rawPath: string): boolean {
  return /(^|\/)(bundle|main|app|vendor|chunk[^/]*)\.(js|mjs|cjs)$/.test(rawPath) || /\/static\/js\//.test(rawPath);
}

/** Webpack/rollup source names → workspace-relative path.
 *  e.g. "webpack://myapp/./src/js/main.jsx" → "src/js/main.jsx" */
export function normalizeSourceMapSource(source: string): string {
  return source
    .replace(/^webpack:\/\/[^/]*\//, "")
    .replace(/^webpack:\/\//, "")
    .replace(/^file:\/\//, "")
    .replace(/^(\.\.?\/)+/, "")
    .replace(/\?.*$/, "");
}

/** Strip ANSI escape codes so regexes and the webview see plain text. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** A short human message for a ref: the nearest "error-ish" line at or above it. */
export function messageNear(text: string, offset: number): string {
  const lineStartAt = text.lastIndexOf("\n", offset) + 1;
  const lineEndAt = text.indexOf("\n", offset);
  // Python tracebacks put the useful line *after* the frames: "ValueError: bad input".
  if (lineEndAt !== -1 && /^\s*File "/.test(text.slice(lineStartAt, lineEndAt))) {
    const after = text.slice(lineEndAt + 1).split("\n").slice(0, 30);
    const exc = after.find((l) => /^[\w.]*(Error|Exception|Exit|Interrupt)\b(:|$)/.test(l.trim()));
    if (exc) return exc.trim();
  }
  const lines = text.slice(0, offset).split("\n");
  for (let i = lines.length - 1, n = 0; i >= 0 && n < 15; i--, n++) {
    const l = lines[i].trim();
    if (/(Error|Exception|assert|FAILED|failed|expected|✖|Timed out)/.test(l) && l.length < 400) {
      // Cypress/mocha: "TypeError: The following error originated…" then "  > Cannot read properties…"
      const errType = l.match(/^(\w*Error):/)?.[1];
      const detail = lines.slice(i + 1, i + 4).map((x) => x.match(/^\s*>\s+(.+)/)?.[1]).find(Boolean);
      if (errType && detail) return `${errType}: ${detail.trim()}`;
      return l;
    }
  }
  const lineStart = text.lastIndexOf("\n", offset) + 1;
  const lineEnd = text.indexOf("\n", offset);
  return text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
}
