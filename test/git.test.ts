import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { approxCommitAt, changedFiles, listSnapshots, pinSnapshot, snapshotWorkingTree } from "../src/git.ts";

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-git-"));
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const commitAt = (date: string, msg: string) => execFileSync("git", ["commit", "-qam", msg], {
    cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "build/\n");
  g("add", "-A");
  commitAt("2026-10-01T12:00:00Z", "first");
  return { dir, g, commitAt };
}

test("clean tree: snapshot is just HEAD", async () => {
  const { dir, g } = repo();
  const snap = await snapshotWorkingTree(dir, "msg");
  assert.equal(snap.dirty, false);
  assert.equal(snap.sha, g("rev-parse", "HEAD"));
});

test("dirty tree: captures edits + untracked files without touching HEAD, index or status", async () => {
  const { dir, g } = repo();
  fs.writeFileSync(path.join(dir, "a.txt"), "two\n");             // unstaged edit
  fs.writeFileSync(path.join(dir, "new.txt"), "untracked\n");     // untracked
  fs.mkdirSync(path.join(dir, "build"));
  fs.writeFileSync(path.join(dir, "build", "out.bin"), "x");      // ignored
  fs.writeFileSync(path.join(dir, "staged.txt"), "s\n");
  g("add", "staged.txt");                                          // something staged
  const before = { head: g("rev-parse", "HEAD"), status: g("status", "--porcelain"), cached: g("diff", "--cached", "--name-only") };

  const snap = await snapshotWorkingTree(dir, "autograder: test");
  assert.equal(snap.dirty, true);
  assert.notEqual(snap.sha, snap.head);
  assert.deepEqual({ head: g("rev-parse", "HEAD"), status: g("status", "--porcelain"), cached: g("diff", "--cached", "--name-only") }, before);

  assert.equal(g("show", `${snap.sha}:a.txt`), "two");
  assert.equal(g("show", `${snap.sha}:new.txt`), "untracked");
  assert.equal(g("show", `${snap.sha}:staged.txt`), "s");
  assert.throws(() => g("show", `${snap.sha}:build/out.bin`));     // .gitignore respected
  assert.equal(g("rev-parse", `${snap.sha}^`), snap.head);

  await pinSnapshot(dir, 3190490, snap);
  const listed = await listSnapshots(dir);
  assert.deepEqual(listed.get(3190490), { submissionPk: 3190490, sha: snap.sha, head: snap.head, dirty: true, kind: "exact" });

  // Working tree equals the snapshot right now → nothing to compare.
  assert.deepEqual(await changedFiles(dir, snap.sha), []);
  fs.writeFileSync(path.join(dir, "a.txt"), "three\n");
  assert.deepEqual(await changedFiles(dir, snap.sha), [{ status: "M", path: "a.txt" }]);
});

test("approxCommitAt picks the last commit before a timestamp", async () => {
  const { dir, g, commitAt } = repo();
  const first = g("rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "a.txt"), "later\n");
  commitAt("2026-10-05T12:00:00Z", "second");
  const second = g("rev-parse", "HEAD");
  assert.equal(await approxCommitAt(dir, "2026-10-03T00:00:00Z"), first);
  assert.equal(await approxCommitAt(dir, "2026-10-06T00:00:00Z"), second);
  assert.equal(await approxCommitAt(dir, "2026-09-01T00:00:00Z"), undefined);
});
