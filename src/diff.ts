// Expected-vs-actual output diffs, as autograder.io computes them.
//
// The server runs GNU diff (expected first, student second) with difflib-style line formats and
// returns a JSON list of strings: "  " (both), "- " (expected only) or "+ " (yours only), then the
// line itself *including* its "\n". A line without one was the last line of a file that has no
// final newline (autograder-server core/utils.py get_diff).

export type Op = " " | "-" | "+";

export interface DiffLine { op: Op; text: string; eol: boolean }

/** One line on one side of the side-by-side view. `hl` marks the differing span [start, end). */
export interface Side { n: number; text: string; eol: boolean; hl?: [number, number] }

/** Unchanged lines have both sides; a changed pair has both; a lone add/remove has one. */
export interface Row { same: boolean; exp?: Side; act?: Side }

/** Collapsed run of unchanged rows, expandable in the UI. */
export interface Skip { skip: Row[] }

export type Item = Row | Skip;

export interface DiffView {
  items: Item[];
  /** Number of expected-only / yours-only lines. */
  removed: number;
  added: number;
  /** Rows beyond the render cap were dropped. */
  truncated: boolean;
}

export function parseDiff(content: string[]): DiffLine[] {
  return content.map((raw) => {
    const op = (raw[0] === "-" || raw[0] === "+" ? raw[0] : " ") as Op;
    const body = raw.slice(2);
    const eol = body.endsWith("\n");
    return { op, text: eol ? body.slice(0, -1) : body, eol };
  });
}

/**
 * Align the diff into side-by-side rows the way autograder.io's website does: a block of "-" lines
 * followed by a block of "+" lines is paired up row by row; leftovers get a blank on the other side.
 */
export function toRows(lines: DiffLine[]): Row[] {
  const rows: Row[] = [];
  let e = 0, a = 0, i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.op === " ") {
      rows.push({ same: true, exp: { n: ++e, text: l.text, eol: l.eol }, act: { n: ++a, text: l.text, eol: l.eol } });
      i++;
      continue;
    }
    const minus: DiffLine[] = [], plus: DiffLine[] = [];
    while (i < lines.length && lines[i].op === "-") minus.push(lines[i++]);
    while (i < lines.length && lines[i].op === "+") plus.push(lines[i++]);
    for (let k = 0; k < Math.max(minus.length, plus.length); k++) {
      const exp: Side | undefined = minus[k] && { n: ++e, text: minus[k].text, eol: minus[k].eol };
      const act: Side | undefined = plus[k] && { n: ++a, text: plus[k].text, eol: plus[k].eol };
      if (exp && act) [exp.hl, act.hl] = changedSpans(exp.text, act.text);
      rows.push({ same: false, exp, act });
    }
  }
  return rows;
}

/** The middle span that differs between two lines, after trimming their common prefix and suffix. */
export function changedSpans(x: string, y: string): [[number, number], [number, number]] {
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  return [[p, x.length - s], [p, y.length - s]];
}

/** Collapse unchanged runs to `context` lines around each change; cap the rows actually rendered. */
export function buildView(content: string[], context = 3, maxRows = 3000): DiffView {
  const lines = parseDiff(content);
  const rows = toRows(lines);
  const items: Item[] = [];
  let i = 0;
  while (i < rows.length) {
    if (!rows[i].same) { items.push(rows[i++]); continue; }
    let j = i;
    while (j < rows.length && rows[j].same) j++;
    const head = i === 0 ? 0 : context;              // context after the previous change
    const tail = j === rows.length ? 0 : context;    // context before the next change
    if (j - i > head + tail + 1) {
      items.push(...rows.slice(i, i + head), { skip: rows.slice(i + head, j - tail) }, ...rows.slice(j - tail, j));
    } else {
      items.push(...rows.slice(i, j));
    }
    i = j;
  }
  const removed = lines.filter((l) => l.op === "-").length;
  const added = lines.filter((l) => l.op === "+").length;
  // A passing output may come back as [] or as all-"  " lines: either way there's nothing to show.
  if (!removed && !added) return { items: [], removed, added, truncated: false };
  // Cap what's rendered (a collapsed run counts as one row): a huge output shouldn't freeze the webview.
  const truncated = items.length > maxRows;
  return { items: truncated ? items.slice(0, maxRows) : items, removed, added, truncated };
}

/** The expected output, rebuilt from the diff (every line the student's output lacks or shares). */
export function expectedText(content: string[]): string {
  return parseDiff(content).filter((l) => l.op !== "+").map((l) => l.text + (l.eol ? "\n" : "")).join("");
}
