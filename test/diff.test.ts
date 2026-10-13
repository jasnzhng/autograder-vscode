import { test } from "node:test";
import assert from "node:assert/strict";
import { buildView, changedSpans, expectedText, parseDiff, toRows, type Row } from "../src/diff.ts";

// Shaped like autograder.io's stdout_diff response for EECS 280 euchre (expected first, student second).
const euchre = [
  "- ./euchre.exe pack.in noshuffle 1 Adi Simple Barbara Simple Chi-Chih Simple Dabbala Simple\n",
  "  Hand 0\n",
  "  Adi deals\n",
  "  King of Clubs led by Dabbala\n",
  "- Ace of Clubs played by Adi\n",
  "- Nine of Spades played by Barbara\n",
  "+ Ten of Diamonds played by Adi\n",
  "  Dabbala takes the trick\n",
];

test("parseDiff splits opcode, text and trailing newline", () => {
  assert.deepEqual(parseDiff(["  same\n", "- gone\n", "+ new", "  \n"]), [
    { op: " ", text: "same", eol: true },
    { op: "-", text: "gone", eol: true },
    { op: "+", text: "new", eol: false },
    { op: " ", text: "", eol: true },
  ]);
});

test("toRows pairs a removed block with the following added block, numbering each side", () => {
  const rows = toRows(parseDiff(euchre));
  const view = rows.map((r) => [r.same, r.exp?.n ?? null, r.exp?.text ?? null, r.act?.n ?? null, r.act?.text ?? null]);
  assert.deepEqual(view, [
    [false, 1, euchre[0].slice(2, -1), null, null],
    [true, 2, "Hand 0", 1, "Hand 0"],
    [true, 3, "Adi deals", 2, "Adi deals"],
    [true, 4, "King of Clubs led by Dabbala", 3, "King of Clubs led by Dabbala"],
    [false, 5, "Ace of Clubs played by Adi", 4, "Ten of Diamonds played by Adi"],
    [false, 6, "Nine of Spades played by Barbara", null, null],
    [true, 7, "Dabbala takes the trick", 5, "Dabbala takes the trick"],
  ]);
});

test("changedSpans trims the common prefix and suffix", () => {
  // "Club|s played by Adi" / "Diamond|s played by Adi": the shared "s" is part of the suffix.
  assert.deepEqual(changedSpans("Ace of Clubs played by Adi", "Ten of Diamonds played by Adi"),
    [[0, 11], [0, 14]]);
  // A trailing space: the highlighted span is exactly the extra character.
  assert.deepEqual(changedSpans("score 10", "score 10 "), [[8, 8], [8, 9]]);
  assert.deepEqual(changedSpans("same", "same"), [[4, 4], [4, 4]]);
});

test("paired rows carry highlight spans", () => {
  const [row] = toRows(parseDiff(["- x = 1\n", "+ x = 2\n"]));
  assert.deepEqual(row.exp?.hl, [4, 5]);
  assert.deepEqual(row.act?.hl, [4, 5]);
});

test("buildView collapses long unchanged runs to context lines around each change", () => {
  const same = (i: number) => `  line ${i}\n`;
  const content = [
    ...Array.from({ length: 20 }, (_, i) => same(i)),
    "- old\n", "+ new\n",
    ...Array.from({ length: 20 }, (_, i) => same(i + 20)),
    "- old2\n",
    ...Array.from({ length: 5 }, (_, i) => same(i + 40)),
  ];
  const v = buildView(content, 3);
  const shape = v.items.map((it) => ("skip" in it ? `skip${it.skip.length}` : (it as Row).same ? "=" : "≠"));
  assert.deepEqual(shape, [
    "skip17", "=", "=", "=",              // leading run: only the 3 lines before the change
    "≠",
    "=", "=", "=", "skip14", "=", "=", "=", // middle run: 3 after, 3 before the next change
    "≠",
    "=", "=", "=", "skip2",                 // trailing run: 3 after
  ]);
  assert.equal(v.removed, 2);
  assert.equal(v.added, 1);
  assert.equal(v.truncated, false);
  // Collapsed rows keep their real line numbers for when they're expanded.
  const first = v.items[0];
  assert.ok("skip" in first && first.skip[0].exp?.n === 1 && first.skip[16].act?.n === 17);
});

test("buildView doesn't collapse a run that's barely longer than its context", () => {
  const v = buildView(["- a\n", "  1\n", "  2\n", "  3\n", "  4\n", "  5\n", "  6\n", "  7\n", "+ b\n"], 3);
  assert.ok(v.items.every((it) => !("skip" in it)));
});

test("buildView of a matching output is empty, whether the server sends [] or only unchanged lines", () => {
  const none = { items: [], removed: 0, added: 0, truncated: false };
  assert.deepEqual(buildView([]), none);
  assert.deepEqual(buildView(["  a\n", "  b\n"]), none);
});

// Cases from autograder-server's own get_diff tests (core/tests/test_utils.py).
test("a missing final newline and a stray \\r make otherwise-identical lines differ", () => {
  const rows = toRows(parseDiff(["+ spam\n", "  egg\n", "- sausage", "+ sausage\n"]));
  assert.deepEqual(rows.at(-1), {
    same: false,
    exp: { n: 2, text: "sausage", eol: false, hl: [7, 7] },
    act: { n: 3, text: "sausage", eol: true, hl: [7, 7] },
  });
  const [, cr] = toRows(parseDiff(["  egg\n", "- cheese", "+ cheese\r\n"]));
  assert.equal(cr.act?.text, "cheese\r");
  assert.deepEqual(cr.act?.hl, [6, 7]);
});

test("buildView caps the rendered rows", () => {
  const content = Array.from({ length: 50 }, (_, i) => `- ${i}\n`);
  const v = buildView(content, 3, 10);
  assert.equal(v.items.length, 10);
  assert.equal(v.truncated, true);
});

test("expectedText rebuilds the expected output, including a missing final newline", () => {
  assert.equal(expectedText(euchre).split("\n")[0], euchre[0].slice(2, -1));
  assert.equal(expectedText(["  a\n", "- b\n", "+ c\n", "- d"]), "a\nb\nd");
});
