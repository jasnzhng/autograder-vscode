# Development

← [Back to README](../README.md)

## Setup

```bash
npm install
npm run build        # esbuild → dist/extension.js
npm run watch        # rebuild on change
npm run typecheck    # tsc --noEmit
npm test             # node --test (Node ≥ 22.6 runs the .ts tests directly)
npm run package      # → .vsix
```

Press **F5** in VS Code to launch an Extension Development Host. In that mode `autograder.dryRun` defaults to **on**, so nothing can be uploaded unless you explicitly set `"autograder.dryRun": false`.

## Tests

| File | Covers |
|---|---|
| `test/linkParser.test.ts` | Reference patterns (Cypress/browser stacks, Python tracebacks, pytest, gcc/clang, valgrind), choosing messages, source-path normalization, fnmatch, expected-file matching, inferring archive contents, generated and pasted tar commands. |
| `test/git.test.ts` | Snapshots in throwaway repos. Checks that `HEAD`, the index and `git status` are unchanged afterwards, that untracked files are captured, that `.gitignore` is respected, and that the "compare with current" diff and timestamp-based commit lookup are correct. |
| `test/diff.test.ts` | Parsing autograder.io's output diffs (missing final newline, `\r`), aligning them side by side like the website, highlighting the changed part of a line, collapsing unchanged runs, and rebuilding the expected output. |
| `test/pending.test.ts` | Hash-matching website uploads to builds, including choosing the right build out of several and never re-downloading a submission. |

Modules covered by unit tests avoid importing `vscode` at runtime, so they run under plain `node --test`.

## Offline demo kit

The screenshots in the README come from the real extension running against a **fake autograder.io** with fictional data. You can use the same setup to work on the UI without an account and without any risk to real submissions:

```bash
node demo/setup.mjs /tmp/ag-demo          # fictional "Recipe Box" project + git history + bundle with source map
node demo/mock-server.mjs /tmp/ag-demo    # read-only fake API on http://127.0.0.1:4785
AUTOGRADER_TOKEN=demo code --extensionDevelopmentPath="$PWD" /tmp/ag-demo
```

- **`demo/setup.mjs`** creates:
  - a JSX front end bundled by esbuild with a source map, and a small Python back end;
  - dated commits, and a pinned snapshot for submission #1004;
  - `.vscode/settings.json` pointing at the mock server (`autograder.baseUrl`).
- **`demo/mock-server.mjs`** serves four graded submissions. Their output includes:
  - a crash in the bundled `app.js` that maps back to `web/src/App.jsx`,
  - a pytest failure with a Python traceback into `server/routes.py`,
  - an expected-output test (`test_export_public`) whose only feedback is the diff, with a rounding bug, a stray trailing space and a missing final newline.

  It accepts any token and refuses every non-GET request.
- **`AUTOGRADER_TOKEN`**: when it's set and there's no stored token for the configured server, the extension uses it. Handy for demos and automation. Unlike a stored token, it's sent to whatever `autograder.baseUrl` says, so never put a real token in it.
