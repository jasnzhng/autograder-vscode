import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { matchPending, recordPending } from "../src/pending.ts";
import { listSnapshots, snapshotWorkingTree } from "../src/git.ts";

class Memento {
  private m = new Map<string, unknown>();
  get<T>(k: string, d?: T): T { return (this.m.has(k) ? this.m.get(k) : d) as T; }
  async update(k: string, v: unknown) { this.m.set(k, v); }
  keys() { return [...this.m.keys()]; }
}

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-pend-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  g("init", "-q"); g("config", "user.email", "t@e.com"); g("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "main.jsx"), "v1\n");
  g("add", "-A"); g("commit", "-qm", "init");
  return { dir, g };
}

const sub = (pk: number, minutesFromNow: number) => ({
  pk, group: 1, timestamp: new Date(Date.now() + minutesFromNow * 60000).toISOString(), submitter: "me",
  submitted_filenames: ["submit.tar.gz"], discarded_files: [], missing_files: {}, status: "finished_grading" as const,
  is_past_daily_limit: false, is_bonus_submission: false, position_in_queue: 0,
});

test("a website upload is linked to the build whose bytes it matches — not just the latest one", async () => {
  const { dir, g } = repo();
  const state = new Memento();
  const tarA = new Uint8Array([1, 2, 3]), tarB = new Uint8Array([4, 5, 6]);

  // Build A (dirty edit), then build B (another edit). The user uploads A's tarball.
  fs.writeFileSync(path.join(dir, "main.jsx"), "v2\n");
  const snapA = await snapshotWorkingTree(dir, "A");
  await recordPending(state as any, 1234, dir, snapA, [{ name: "submit.tar.gz", data: tarA }]);
  fs.writeFileSync(path.join(dir, "main.jsx"), "v3\n");
  const snapB = await snapshotWorkingTree(dir, "B");
  await recordPending(state as any, 1234, dir, snapB, [{ name: "submit.tar.gz", data: tarB }]);
  // Pending snapshots are kept alive by refs until matched.
  assert.equal(g("for-each-ref", "--format=%(refname)", "refs/autograder/pending/").split("\n").length, 2);

  const downloads: number[] = [];
  const client = { submittedFile: async (pk: number) => { downloads.push(pk); return pk === 501 ? tarA : new Uint8Array([9]); } };
  const submissions = [sub(500, -60) /* before any build */, sub(501, 1), sub(502, 2)];

  const matched = await matchPending(state as any, 1234, dir, client as any, submissions as any, new Set());
  assert.deepEqual(matched, [501]);
  assert.deepEqual(downloads.sort(), [501, 502]);          // #500 predates the builds: never downloaded
  const snaps = await listSnapshots(dir);
  assert.equal(snaps.get(501)?.sha, snapA.sha);
  assert.equal(g("show", `${snapA.sha}:main.jsx`), "v2");

  // Second pass: nothing re-downloaded, B still pending with its ref.
  await matchPending(state as any, 1234, dir, client as any, submissions as any, new Set([501]));
  assert.deepEqual(downloads.sort(), [501, 502]);
  assert.equal(g("for-each-ref", "--format=%(objectname)", "refs/autograder/pending/"), snapB.sha);
});
