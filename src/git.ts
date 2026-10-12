import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

export interface Snapshot {
  submissionPk: number;
  /** Commit that captures the working tree at submit time. */
  sha: string;
  /** HEAD at submit time (equals `sha` when the tree was clean). */
  head: string;
  dirty: boolean;
  /** "exact" = recorded at submit time; "approx" = inferred from timestamps. */
  kind: "exact" | "approx";
}

export const REF_PREFIX = "refs/autograder/submissions/";
const MAX_UNTRACKED = 1000;

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env: { ...process.env, ...env }, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout.trim()));
  });
}

export async function repoRoot(cwd: string): Promise<string | undefined> {
  try { return await git(cwd, ["rev-parse", "--show-toplevel"]); } catch { return undefined; }
}

/**
 * Commit the *current working tree* (tracked + untracked, respecting .gitignore) without
 * touching HEAD, the real index, or the stash: build a tree in a throwaway index file,
 * wrap it in a commit whose parent is HEAD, and pin it under refs/autograder/ so gc keeps it.
 */
export async function snapshotWorkingTree(root: string, message: string): Promise<Omit<Snapshot, "submissionPk" | "kind">> {
  const head = await git(root, ["rev-parse", "HEAD"]);
  const status = await git(root, ["status", "--porcelain", "--untracked-files=all"]);
  const dirty = status.length > 0;
  // Guard: an un-ignored env/ or node_modules/ would get hashed into the object store on every submit.
  const untracked = status.split("\n").filter((l) => l.startsWith("??")).length;
  if (untracked > MAX_UNTRACKED) {
    throw new Error(`${untracked} untracked files — add build/env folders to .gitignore. Skipping snapshot.`);
  }
  const sha = dirty ? await git(root, ["commit-tree", await workingTreeTree(root), "-p", head, "-m", message]) : head;
  return { sha, head, dirty };
}

/** Tree object for the working tree as-is (tracked + untracked, minus ignored), built in a
 *  throwaway index so the user's real index is never touched. */
async function workingTreeTree(root: string): Promise<string> {
  const tmpIndex = path.join(os.tmpdir(), `ag-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    // Seeding from the real index makes `add -A` fast (stat info is reused).
    const realIndex = await git(root, ["rev-parse", "--git-path", "index"]);
    await fs.copyFile(path.resolve(root, realIndex), tmpIndex).catch(() => undefined);
    const env = { GIT_INDEX_FILE: tmpIndex };
    await git(root, ["add", "-A"], env);
    return await git(root, ["write-tree"], env);
  } finally {
    await fs.rm(tmpIndex, { force: true });
  }
}

/** Pin a snapshot under refs/autograder/submissions/<pk> so it survives gc and shows up later. */
export async function pinSnapshot(root: string, submissionPk: number, snap: { sha: string; head: string }): Promise<void> {
  await git(root, ["update-ref", REF_PREFIX + submissionPk, snap.sha]);
  // Remember HEAD alongside, so we can say "HEAD + uncommitted changes".
  await git(root, ["update-ref", `${REF_PREFIX}${submissionPk}-head`, snap.head]);
}

export async function pinRef(root: string, ref: string, sha: string): Promise<void> {
  await git(root, ["update-ref", ref, sha]);
}

export async function deleteRef(root: string, ref: string): Promise<void> {
  await git(root, ["update-ref", "-d", ref]);
}

/** All snapshots recorded by this extension in this repo. */
export async function listSnapshots(root: string): Promise<Map<number, Snapshot>> {
  const out = new Map<number, Snapshot>();
  let lines: string;
  try {
    lines = await git(root, ["for-each-ref", "--format=%(refname) %(objectname)", REF_PREFIX]);
  } catch { return out; }
  const heads = new Map<number, string>();
  for (const line of lines.split("\n").filter(Boolean)) {
    const [ref, sha] = line.split(" ");
    const m = ref.slice(REF_PREFIX.length).match(/^(\d+)(-head)?$/);
    if (!m) continue;
    const pk = Number(m[1]);
    if (m[2]) heads.set(pk, sha);
    else out.set(pk, { submissionPk: pk, sha, head: sha, dirty: false, kind: "exact" });
  }
  for (const [pk, head] of heads) {
    const s = out.get(pk);
    if (s) { s.head = head; s.dirty = head !== s.sha; }
  }
  return out;
}

/** Best guess for submissions made outside the extension: last commit on HEAD before the timestamp. */
export async function approxCommitAt(root: string, isoTimestamp: string): Promise<string | undefined> {
  try {
    const sha = await git(root, ["rev-list", "-1", `--before=${isoTimestamp}`, "HEAD"]);
    return sha || undefined;
  } catch { return undefined; }
}

export async function shortLog(root: string, sha: string): Promise<string> {
  try { return await git(root, ["log", "-1", "--format=%h %s", sha]); } catch { return sha.slice(0, 7); }
}

export async function changedFiles(root: string, sha: string): Promise<Array<{ status: string; path: string }>> {
  // Compare the snapshot to the working tree *including untracked files*; plain
  // `git diff <sha>` would report files that are untracked now as deleted.
  const out = await git(root, ["diff", "--name-status", "--no-renames", sha, await workingTreeTree(root)]);
  return out.split("\n").filter(Boolean).map((l) => {
    const [status, ...rest] = l.split("\t");
    return { status, path: rest.join("\t") };
  });
}

export async function isDirty(root: string): Promise<boolean> {
  return (await git(root, ["status", "--porcelain"])).length > 0;
}

export async function createBranchAt(root: string, name: string, sha: string): Promise<void> {
  await git(root, ["switch", "-c", name, sha]);
}

export async function branchExists(root: string, name: string): Promise<boolean> {
  try { await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]); return true; } catch { return false; }
}
