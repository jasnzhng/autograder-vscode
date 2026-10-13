# Changelog

## 0.1.3

- **Expected vs. actual output.** For tests graded by comparing your output with an expected output (like EECS 280's `.correct` files), "Output & diff" shows autograder.io's diff: side by side when there's room, unified in the sidebar, with the changed part of each line highlighted and long matching stretches collapsed. "Show whitespace" makes spaces, tabs and line ends visible, and a missing final newline or `\r` is always marked. "Open in diff editor" compares the expected output with your real output in VS Code's diff editor.
- **Fixed: output wrongly marked "output hidden".** Tests whose feedback shows expected and actual output, but not "show actual output", now show your output, and their failures appear in "Show failures in Problems".
- **Fixed: a required file reported missing when it also matched a wildcard.** When one file matched two expected patterns, it only counted toward the first. In EECS 370, for example, `simulator.c` also matches `*.[as,s,lc2k]`, so submitting stopped with "No file matching simulator.c". Like autograder.io, a file now counts toward every pattern it matches, and it's still uploaded only once.

## 0.1.2

- **Your token only goes back to the server that issued it.** Before, a project's `.vscode/settings.json` could set `autograder.baseUrl` and have VS Code send your stored token there as soon as the folder opened. Now the token is stored with its server, and when the setting points anywhere else you're simply signed out. Signing in to a server other than autograder.io asks first, and the URL must be `https://` (plain `http://` only on localhost). Tokens saved by 0.1.x are treated as autograder.io's.
- **Student data only.** The course picker no longer lists courses you're on staff for. Viewing failures in Problems now also checks that the submission is in your own group's list instead of fetching it by id, so every code path reads only your own submissions, even with a staff token.
- **Pasting a multi-line `tar` command from the spec works.** VS Code's input box is single-line and dropped the line breaks, so `\`-continued commands reached the shell as `tar \ --exclude …` and failed. Choosing "Paste the command" now fills the box from your clipboard with the lines already joined, and a command pasted into the box by hand is repaired too.
- New extension icon.

## 0.1.1

- **Sign-in uses the `agtoken` download.** autograder.io's token page downloads a file instead of displaying the token. The extension now watches your Downloads folder for it and imports it automatically. It also reuses `~/.agtoken` when present, falls back to choosing the file or pasting it, and offers to delete the downloaded copy or move it to `~/.agtoken` afterwards.

## 0.1.0

First release.

- **Autograder sidebar** (activity bar), which can pop out into an editor tab. Shows the project, deadline and daily quota, every submission with its score, and expandable suites and tests with output loaded on demand. Also shows mutation-testing results.
- **Clickable file references in test output.** The autograder's sandbox paths are mapped to your workspace. Bundled-JS stack frames are source-mapped using the map from the submitted tarball.
- **"Show failures in Problems".** File references from every failing test's output become diagnostics in the Problems panel.
- **Build & Open in Browser** (the default) and **Submit directly**.
- **First-run setup from the project's expected files.** For tarballs, you can paste the spec's command, pick the contents, or use your own script.
- **Git snapshots for every build**, with exact SHA-256 matching for uploads made on the website, plus Compare with current, Check out as branch and Copy SHA.
- **Status bar item** showing the latest score and submissions left today.
- **Offline demo kit** (`demo/`) with a read-only mock autograder.io server.
