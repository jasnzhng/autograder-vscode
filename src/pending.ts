import type * as vscode from "vscode";
import { createHash } from "crypto";
import type { AutograderClient, Submission } from "./api";
import * as git from "./git.ts";

/**
 * "Build & Open in Browser" can't know the submission id (the upload happens on the website),
 * so we remember the snapshot together with a hash of each built file. When a later submission
 * shows up whose uploaded files hash identically, it gets that snapshot — an exact link,
 * not a timestamp guess.
 */
interface Pending {
  sha: string;
  head: string;
  dirty: boolean;
  preparedAt: string;
  files: Record<string, string>;   // basename → sha256
}

const MAX_PENDING = 10;
const key = (projectId: number) => `autograder.pending.${projectId}`;
const checkedKey = (projectId: number) => `autograder.checked.${projectId}`;

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function recordPending(state: vscode.Memento, projectId: number, root: string,
                                    snap: { sha: string; head: string; dirty: boolean },
                                    files: Array<{ name: string; data: Uint8Array }>): Promise<void> {
  const entry: Pending = {
    ...snap, preparedAt: new Date().toISOString(),
    files: Object.fromEntries(files.map((f) => [f.name, sha256(f.data)])),
  };
  // Keep the commit alive until it's matched (unreferenced commits get gc'd eventually).
  await git.pinRef(root, `refs/autograder/pending/${snap.sha}`, snap.sha);
  const list = [entry, ...state.get<Pending[]>(key(projectId), []).filter((p) => p.sha !== snap.sha)];
  for (const dropped of list.splice(MAX_PENDING)) {
    await git.deleteRef(root, `refs/autograder/pending/${dropped.sha}`).catch(() => undefined);
  }
  await state.update(key(projectId), list);
}

/** Pin pending snapshots to newly seen submissions whose files match. Returns matched pks. */
export async function matchPending(state: vscode.Memento, projectId: number, root: string, client: AutograderClient,
                                   submissions: Submission[], alreadyLinked: Set<number>): Promise<number[]> {
  let pending = state.get<Pending[]>(key(projectId), []);
  if (!pending.length) return [];
  const checked = new Set(state.get<number[]>(checkedKey(projectId), []));
  const oldest = Math.min(...pending.map((p) => Date.parse(p.preparedAt)));
  const matched: number[] = [];

  const candidates = submissions
    .filter((s) => !alreadyLinked.has(s.pk) && !checked.has(s.pk) && Date.parse(s.timestamp) >= oldest)
    .sort((a, b) => a.pk - b.pk);   // oldest first, so each build matches its first upload

  for (const sub of candidates) {
    const hashes: Record<string, string> = {};
    for (const name of sub.submitted_filenames) {
      const data = await client.submittedFile(sub.pk, name).catch(() => undefined);
      if (data) hashes[name] = sha256(data);
    }
    checked.add(sub.pk);
    const hit = pending.find((p) => Date.parse(p.preparedAt) <= Date.parse(sub.timestamp)
      && Object.keys(p.files).length > 0
      && Object.entries(p.files).every(([name, h]) => hashes[name] === h));
    if (!hit) continue;
    await git.pinSnapshot(root, sub.pk, hit);
    await git.deleteRef(root, `refs/autograder/pending/${hit.sha}`).catch(() => undefined);
    pending = pending.filter((p) => p !== hit);
    matched.push(sub.pk);
  }
  await state.update(key(projectId), pending);
  await state.update(checkedKey(projectId), [...checked].slice(-500));
  return matched;
}
