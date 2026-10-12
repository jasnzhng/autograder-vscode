# How it works

← [Back to README](../README.md)

- [Signing in](#signing-in)
- [Finding your project](#finding-your-project)
- [Turning output into links](#turning-output-into-links)
- [Source maps for bundled JavaScript](#source-maps-for-bundled-javascript)
- [Building and submitting](#building-and-submitting)
- [Snapshots: tying submissions to code](#snapshots-tying-submissions-to-code)
- [Source layout](#source-layout)

## Signing in

autograder.io signs you in with Google. Google's sign-in pages can't be used inside VS Code: they refuse to load in embedded frames, and webviews have no access to your browser's cookies. The website itself, though, authenticates every API call with a [Django REST Framework token](https://www.django-rest-framework.org/api-guide/authentication/#tokenauthentication). It sends the header `Authorization: Token <token>`. The page **`/web/__apitoken__`** doesn't display that token: it downloads it as a small file named **`agtoken`**, whose only content is the token (see `api_token.vue` in [ag-website-vue](https://github.com/eecs-autograder/ag-website-vue)).

**Autograder: Sign In** handles that file for you ([`session.ts`](../src/session.ts), [`tokenFile.ts`](../src/tokenFile.ts)):

1. **Reuse a token that's already on disk.** It checks `~/.agtoken` (where autograder.io's CLI expects the token), a `.agtoken` in the workspace, and any `agtoken` already in `~/Downloads`. It asks before using one.
2. **Otherwise, open the token page and watch `~/Downloads`.** It looks for a new file named `agtoken`, or `agtoken (1)`, `agtoken-2`, `agtoken.txt` (the names browsers give repeat downloads), created after sign-in started. It checks for up to 5 minutes, and you can cancel.
3. **Fall back** to choosing the file by hand, or pasting its contents.
4. **Validate and store.** The token is checked against `GET /api/users/current/` and stored, together with the server it came from, in VS Code's [`SecretStorage`](https://code.visualstudio.com/api/references/vscode-api#SecretStorage), which is backed by the OS keychain. The downloaded file is a credential in plain text, so the extension offers to delete it, or move it to `~/.agtoken` (permissions `600`) for use with the CLI.

On macOS, VS Code may ask once for permission to read your Downloads folder.

The token is only ever sent back to the server that issued it. `autograder.baseUrl` can be set by a project's `.vscode/settings.json`, so if it points anywhere else the extension treats you as signed out instead of sending the token there. Signing in to a server other than autograder.io asks for confirmation first, and the URL must be `https://` (plain `http://` only on localhost, for the demo kit).

> autograder.io keeps exactly **one** token per user, and your browser session uses it too. That's why **Sign Out** only forgets the token locally. Revoking it on the website would also log you out of the site.

## Finding your project

On first use, the extension searches `makesubmit`, Makefiles, `*.sh`, `bin/*` and README/Markdown files for an `autograder.io/web/project/<id>` URL. If it finds one, it uses that ID. Otherwise it lists the courses you're enrolled in (newest term first) and their projects. The choice is saved to `.vscode/settings.json` as `autograder.projectId`.

## Turning output into links

Test output is fetched only when you expand a test. It's then split into plain text and clickable references, which happens in the extension, not the webview ([`linkParser.ts`](../src/linkParser.ts), [`resolver.ts`](../src/resolver.ts)):

1. **Find references.** Several patterns are applied in priority order, and overlapping matches are discarded:
   - Python tracebacks: `File "…", line N`
   - URL stack frames: `http://host/static/js/bundle.js:L:C`
   - generic `path.ext:L[:C]`: gcc/clang, pytest, eslint, Node, valgrind `(file.cpp:42)`
   - MSVC-style `path(L[,C])`
2. **Strip the sandbox prefix.** Paths like `/home/autograder/working_dir/submit/` become workspace-relative candidates, tried longest first: `server/views/x.py` → `views/x.py` → `x.py`. If none exists, the extension falls back to a basename index of the workspace and picks the file whose path shares the most trailing segments with the reported one.
3. **Skip noise.** Anything under `node_modules`, `site-packages`, `/usr/lib` and similar is never linked.
4. **Pick the message.** The **Problems** panel needs one line per reference:
   - For Python tracebacks, it uses the exception line that follows the frames (`ValueError: …`).
   - For Cypress/Mocha output, it combines `TypeError:` with the `> Cannot read properties…` detail line.
   - Otherwise, it uses the nearest error-looking line above the reference.

## Source maps for bundled JavaScript

For web projects, frames point into a bundle (`app.js:1204:17`). Your local `bundle.js.map` is the wrong map as soon as you rebuild. So for each submission, the extension:

1. **Downloads the files you submitted** (`GET /api/submissions/<id>/file/?filename=…`) into its own storage. Archives are extracted with the system `tar`, and the result is cached per submission.
2. **Finds the right map.** It looks for the `.map` whose name matches the frame's file, preferring the longest matching path.
3. **Maps the position** with [`@jridgewell/trace-mapping`](https://github.com/jridgewell/trace-mapping). Stack columns are 1-based; the mapping library uses 0-based columns.
4. **Resolves the source path.**
   - webpack-style sources (`webpack://app/./src/x.jsx`) are normalized.
   - Relative sources (`../../js/x.jsx`, as esbuild and rollup write them) are resolved against the map's own location inside the archive.
5. **Hides library frames.** A frame that maps into library code, or maps nowhere, is left unlinked. The extension never falls back to linking the raw bundle when a map exists.

If the submission has no map, a local `*.map` is used instead, and the tooltip warns that it may not match what you submitted.

## Building and submitting

[`onboarding.ts`](../src/onboarding.ts) and [`submit.ts`](../src/submit.ts) handle this.

**First-run setup** starts from the project's `expected_student_files`:

- **Every pattern is an archive** (`*.tar.gz`, `.tgz`, `.tar`, `.zip`, …): the extension asks for a build command. You can:
  - **paste** the spec's command (`$` prompts are removed, backslash continuations joined, multiple lines joined with `&&`). VS Code's input box is single-line and drops pasted line breaks, so the box is pre-filled from the clipboard, which still has them,
  - **pick** the archive's contents from `git ls-files --cached --others --exclude-standard` (so `.gitignore` is respected), or
  - **run your own script**.

  When you pick, an existing archive's contents are pre-checked. They're reconstructed from `tar -tf`, which lists a `dir/` entry for each folder you added but not for the parents of single files you added. The generated command sets `COPYFILE_DISABLE=1` on macOS (so no `._AppleDouble` files end up in the archive) and excludes `__pycache__` and `.DS_Store`. You can edit it before it's saved.
- **Otherwise:** workspace files are matched to each pattern using Python `fnmatch` semantics, comparing basenames because autograder.io flattens uploads. The shallowest matches are pre-selected.

**Build & Open in Browser**
1. Runs the build command.
2. Checks the result against the expected patterns.
3. Takes a snapshot (see below).
4. Opens the project page and reveals the file.
5. Polls every 15 s, for up to 30 min, for a new submission. When one appears, it follows grading and shows the score.

**Submit directly** follows the same steps, plus:
- a confirmation dialog showing files, sizes, modification times, today's quota and the honor pledge,
- the upload: `POST /api/groups/<id>/submissions/` with only `submitted_files` multipart fields,
- polling of `/api/submissions/<id>/` until grading finishes.

Dry run (`autograder.dryRun`, on by default in development builds) stops before any request that writes to the server, including creating a solo group.

## Snapshots: tying submissions to code

[`git.ts`](../src/git.ts) and [`pending.ts`](../src/pending.ts) handle this.

**Taking a snapshot without touching your work:**

```
GIT_INDEX_FILE=<tmp copy of .git/index> git add -A     # tracked + untracked, respects .gitignore
GIT_INDEX_FILE=<tmp>                    git write-tree # → tree of exactly what's on disk
git commit-tree <tree> -p HEAD -m "autograder: …"      # → commit object; HEAD/branch unchanged
```

The commit is kept alive by a ref, so `git gc` won't delete it:

| Ref | Meaning |
|---|---|
| `refs/autograder/submissions/<id>` | The snapshot for submission `<id>`. |
| `refs/autograder/submissions/<id>-head` | `HEAD` at that time. Used for the "+ uncommitted changes" label. |
| `refs/autograder/pending/<sha>` | A build that hasn't been matched to a submission yet. |

As a safeguard, the snapshot is skipped if there are more than 1000 untracked files. That usually means an un-ignored `env/` or `node_modules/`.

**Matching website uploads.** After **Build & Open in Browser**, the extension remembers each built file's SHA-256. When the panel later sees a new submission that isn't linked to a snapshot yet, it downloads that submission's files and compares hashes. The first build whose hashes all match gets linked. A gzip archive's bytes don't change after it's built, and autograder.io returns exactly the bytes you uploaded, so equal hashes prove which build was uploaded. Each submission is checked only once.

**Older submissions** use `git rev-list -1 --before=<timestamp> HEAD`, shown with a `~` and the label "approx."

**Compare with current** builds a tree of the working tree, the same way as a snapshot, and diffs the snapshot against it. That way, files that are still untracked don't show up as "deleted". The result opens in VS Code's multi-file diff editor (`vscode.changes`). **Check out as branch** refuses to run while your tree has uncommitted changes.

## Source layout

| File | |
|---|---|
| [`extension.ts`](../src/extension.ts) | Activation, commands, status bar, upload watcher. |
| [`api.ts`](../src/api.ts) | Typed REST client. |
| [`session.ts`](../src/session.ts) | Token storage and sign-in. |
| [`binding.ts`](../src/binding.ts) | Workspace ↔ project binding, dry-run logic. |
| [`onboarding.ts`](../src/onboarding.ts) | First-run setup, running the build command. |
| [`submit.ts`](../src/submit.ts) | Collecting files, confirmation, upload, Build & Open. |
| [`panel.ts`](../src/panel.ts) + [`media/`](../media) | The webview UI, hosted in the activity-bar sidebar or popped out into an editor tab: controller, then UI (vanilla JS, theme variables, strict CSP). |
| [`linkParser.ts`](../src/linkParser.ts), [`resolver.ts`](../src/resolver.ts) | Finding references and resolving them, including source maps. |
| [`problems.ts`](../src/problems.ts) | Segmenting output for the webview; Problems-panel diagnostics. |
| [`git.ts`](../src/git.ts), [`pending.ts`](../src/pending.ts) | Snapshots and upload matching. |
| [`files.ts`](../src/files.ts) | Pure helpers: fnmatch, expected-file matching, archive commands. |
