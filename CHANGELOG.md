# Changelog

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
