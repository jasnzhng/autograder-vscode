import * as vscode from "vscode";
import { AutograderClient, CommandResult, Submission, SubmissionResults } from "./api";
import { findFileRefs, messageNear, stripAnsi } from "./linkParser";
import { RefResolver } from "./resolver";

/** Output text split into plain runs and clickable refs, ready for the webview. */
export type Segment = { t: string } | { t: string; link: string; title: string; hint?: string };

export class LinkTable {
  private next = 0;
  private table = new Map<string, { uri: vscode.Uri; line: number; column: number }>();
  add(loc: { uri: vscode.Uri; line: number; column: number }): string {
    const id = `l${this.next++}`;
    this.table.set(id, loc);
    return id;
  }
  get(id: string) { return this.table.get(id); }
  clear() { this.table.clear(); }
}

export async function segmentOutput(raw: string, resolver: RefResolver, links: LinkTable): Promise<Segment[]> {
  const text = stripAnsi(raw);
  const refs = findFileRefs(text);
  const resolved = await Promise.all(refs.map((r) => resolver.resolve(r).catch(() => undefined)));
  const out: Segment[] = [];
  let pos = 0;
  refs.forEach((ref, i) => {
    const res = resolved[i];
    if (!res) return;
    if (ref.start > pos) out.push({ t: text.slice(pos, ref.start) });
    const rel = vscode.workspace.asRelativePath(res.uri);
    out.push({
      t: text.slice(ref.start, ref.end),
      link: links.add(res),
      title: `${rel}:${res.line}${res.note ? ` — ${res.note}` : ""}`,
      // Source-mapped refs point somewhere other than the printed text; say where.
      hint: res.note ? `${rel}:${res.line}` : undefined,
    });
    pos = ref.end;
  });
  if (pos < text.length) out.push({ t: text.slice(pos) });
  return out;
}

export function failedVisibleCommands(results: SubmissionResults): Array<{ testName: string; cmd: CommandResult }> {
  const out: Array<{ testName: string; cmd: CommandResult }> = [];
  for (const suite of results.ag_test_suite_results) {
    for (const c of suite.ag_test_case_results) {
      for (const cmd of c.ag_test_command_results) {
        const failed = cmd.total_points < cmd.total_points_possible
          || cmd.return_code_correct === false || cmd.stdout_correct === false || cmd.stderr_correct === false;
        if (failed && (cmd.fdbk_settings.show_actual_stdout || cmd.fdbk_settings.show_actual_stderr)) {
          const testName = c.ag_test_command_results.length > 1
            ? `${c.ag_test_case_name} › ${cmd.ag_test_command_name}` : c.ag_test_case_name;
          out.push({ testName, cmd });
        }
      }
    }
  }
  return out;
}

/** Pull the output of every failed (visible) test and surface file refs in the Problems panel. */
export async function publishProblems(
  collection: vscode.DiagnosticCollection, client: AutograderClient, sub: Submission,
  results: SubmissionResults, resolver: RefResolver, token?: vscode.CancellationToken,
): Promise<number> {
  collection.clear();
  const byFile = new Map<string, vscode.Diagnostic[]>();
  const uris = new Map<string, vscode.Uri>();
  let count = 0;
  for (const { testName, cmd } of failedVisibleCommands(results)) {
    if (token?.isCancellationRequested) break;
    for (const stream of ["stdout", "stderr"] as const) {
      const allowed = stream === "stdout" ? cmd.fdbk_settings.show_actual_stdout : cmd.fdbk_settings.show_actual_stderr;
      if (!allowed) continue;
      const text = stripAnsi(await client.commandOutput(sub, cmd.pk, stream).catch(() => ""));
      const seen = new Set<string>();
      for (const ref of findFileRefs(text)) {
        const res = await resolver.resolve(ref).catch(() => undefined);
        if (!res) continue;
        const key = `${res.uri.toString()}:${res.line}`;
        if (seen.has(key)) continue;   // one diagnostic per location per test
        seen.add(key);
        const line = Math.max(0, res.line - 1);
        const diag = new vscode.Diagnostic(
          new vscode.Range(line, Math.max(0, res.column - 1), line, Number.MAX_SAFE_INTEGER),
          `${testName}: ${messageNear(text, ref.start)}`,
          vscode.DiagnosticSeverity.Error);
        diag.source = `autograder #${sub.pk}`;
        uris.set(res.uri.toString(), res.uri);
        (byFile.get(res.uri.toString()) ?? byFile.set(res.uri.toString(), []).get(res.uri.toString())!).push(diag);
        count++;
      }
    }
  }
  for (const [k, diags] of byFile) collection.set(uris.get(k)!, diags);
  return count;
}
