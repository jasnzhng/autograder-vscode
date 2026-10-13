// Webview UI for the Autograder panel. All server-provided text goes through textContent.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  let state = null;          // last "state" message
  let selected = null;       // selected submission pk
  let results = null;        // results for `selected`
  const scores = {};         // pk -> {points, possible}
  const openKeys = new Set(); // expanded command outputs, survive re-render
  const outputs = {};         // key -> {stdout, stderr, diffs} segments, survive re-render
  const outputCmd = {};       // key -> {pk, cmdPk} for "Open in diff editor"
  const streamView = {};      // `${key}:${stream}` -> "diff" | "output"
  const expanded = new Set(); // `${key}:${stream}:${first expected line}` of unfolded unchanged runs
  let prefs = Object.assign({ showWs: false }, (vscode.getState() || {}).prefs);
  const wide = window.matchMedia("(min-width: 640px)");

  // ---- tiny DOM helper ----------------------------------------------------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style") el.style.cssText = v;   // CSSOM is allowed by our CSP; style="" attrs are not
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const send = (msg) => vscode.postMessage(msg);
  const fmtPts = (p, q) => `${+(+p).toFixed(2)}/${+(+q).toFixed(2)}`;
  const pct = (p, q) => (q > 0 ? p / q : 1);
  const cls = (p, q) => (q === 0 ? "neutral" : p >= q ? "pass" : p > 0 ? "partial" : "fail");

  function ago(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  const fullTime = (iso) => new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  // ---- rendering ----------------------------------------------------------
  function render() {
    if (!state) return;
    app.replaceChildren(header(), h("div", { class: "body" }, sidebar(), detail()));
  }

  function header() {
    const p = state.project, g = state.group;
    const deadline = p.deadline ? new Date(g && g.extension ? g.extension : p.deadline) : null;
    const left = deadline ? deadline - Date.now() : null;
    const quota = p.limit != null && g
      ? h("span", { class: "chip " + (g.usedToday >= p.limit ? "fail" : "") },
          `${Math.max(0, p.limit - g.usedToday)} of ${p.limit} left today${g.bonus ? ` · +${g.bonus} bonus` : ""}`)
      : null;
    const banner = !state.configured && h("div", { class: "banner" },
      h("span", {}, "How should this project be submitted? autograder.io expects: ", (p.expected || []).join(", ") || "—"),
      h("button", { class: "primary", onclick: () => send({ type: "configure" }) }, "Set up"));
    return h("header", { class: banner ? "with-banner" : "" }, banner,
      h("div", { class: "title" },
        h("h1", {}, p.name),
        h("div", { class: "meta" },
          deadline && h("span", { class: "chip " + (left < 0 ? "fail" : left < 86400000 ? "partial" : "") ,
            title: fullTime(deadline.toISOString()) },
            left < 0 ? `Closed ${ago(deadline.toISOString())}` : `Due ${fullTime(deadline.toISOString())}`),
          quota,
          state.dryRun && h("span", { class: "chip partial", title: "autograder.dryRun is on" }, "Dry run"),
          h("span", { class: "muted" }, state.user))),
      h("div", { class: "actions" },
        state.method === "upload"
          ? [h("button", { class: "primary", onclick: () => send({ type: "submit" }), title: "Build and upload directly to autograder.io" }, "Submit"),
             h("button", { onclick: () => send({ type: "prepare" }), title: "Build, then upload yourself on the website" }, "Build & Open")]
          : [h("button", { class: "primary", onclick: () => send({ type: "prepare" }), title: "Build, then upload yourself on the website" }, "Build & Open in Browser"),
             h("button", { onclick: () => send({ type: "submit" }), title: "Build and upload directly to autograder.io" }, "Submit directly")],
        h("button", { onclick: () => send({ type: "configure" }), title: "Configure which files are submitted / how the tarball is built" }, "⚙"),
        h("button", { onclick: () => send({ type: "refresh", pk: selected }), title: "Refresh" }, "↻"),
        h("button", { onclick: () => send({ type: "openInBrowser" }), title: "Open on autograder.io" }, "↗")));
  }

  function sidebar() {
    const subs = state.submissions;
    if (!subs.length) return h("nav", {}, h("div", { class: "empty" }, "No submissions yet."));
    return h("nav", {}, subs.map((s) => {
      const sc = scores[s.pk] || s.score;
      const done = s.status === "finished_grading";
      return h("button", {
        class: "sub" + (s.pk === selected ? " active" : ""),
        onclick: () => { selected = s.pk; results = null; render(); send({ type: "select", pk: s.pk }); },
      },
        h("div", { class: "row" },
          h("span", { class: "pk" }, `#${s.pk}`),
          sc && done ? h("span", { class: "score " + cls(sc.points, sc.possible) }, fmtPts(sc.points, sc.possible))
                     : h("span", { class: "status" }, statusLabel(s))),
        h("div", { class: "row muted small" },
          h("span", { title: fullTime(s.timestamp) }, ago(s.timestamp)),
          s.snapshot && h("span", { class: "sha" + (s.snapshot.kind === "approx" ? " approx" : ""),
            title: s.snapshot.kind === "approx" ? "Inferred: last commit before this submission" : "Snapshot recorded at submit time" },
            (s.snapshot.kind === "approx" ? "~" : "") + s.snapshot.short + (s.snapshot.dirty ? "+" : ""))),
        sc && done && h("div", { class: "bar" }, h("div", { class: "fill " + cls(sc.points, sc.possible), style: `width:${pct(sc.points, sc.possible) * 100}%` })));
    }));
  }

  function statusLabel(s) {
    if (s.status === "queued" && s.queue) return `queued #${s.queue}`;
    return s.status.replace(/_/g, " ");
  }

  function detail() {
    const s = state.submissions.find((x) => x.pk === selected);
    if (!s) return h("main", {}, h("div", { class: "empty" }, "Select a submission."));
    const head = h("section", { class: "summary" },
      h("div", { class: "big" },
        results ? h("span", { class: "score " + cls(+results.total_points, +results.total_points_possible) },
          fmtPts(results.total_points, results.total_points_possible)) : h("span", { class: "muted" }, "…"),
        h("span", { class: "muted" }, ` · ${statusLabel(s)} · ${fullTime(s.timestamp)}`),
        s.pastLimit && h("span", { class: "chip partial" }, "past daily limit"),
        s.bonus && h("span", { class: "chip" }, "bonus")),
      h("div", { class: "muted small" }, "Files: ", s.files.join(", ")),
      snapshotRow(s),
      h("div", { class: "actions" },
        h("button", { onclick: () => send({ type: "problems", pk: s.pk }),
          title: "Fetch output of failing tests and put file/line references in the Problems panel" }, "Show failures in Problems")));
    if (!results) return h("main", {}, head, h("div", { class: "empty" }, "Loading results…"));
    return h("main", {}, head,
      results.ag_test_suite_results.map((suite) => suiteView(s, suite)),
      (results.mutation_test_suite_results || []).map(mutationView));
  }

  function snapshotRow(s) {
    const snap = s.snapshot;
    if (!snap) return h("div", { class: "muted small" }, "No git history linked (not a git repo, or no commits before this submission).");
    return h("div", { class: "snapshot" },
      h("span", { class: "sha" + (snap.kind === "approx" ? " approx" : "") }, snap.short),
      h("span", { class: "subject" }, snap.subject || ""),
      snap.kind === "approx" ? h("span", { class: "muted small", title: "This submission wasn't made from VS Code, so we picked the last commit before its timestamp." }, " (approx.)")
                             : snap.dirty ? h("span", { class: "muted small", title: "Includes uncommitted changes captured at submit time" }, " + uncommitted changes") : null,
      h("span", { class: "spacer" }),
      h("button", { class: "link", onclick: () => send({ type: "compare", pk: s.pk }) }, "Compare with current"),
      h("button", { class: "link", onclick: () => send({ type: "checkout", pk: s.pk }) }, "Check out as branch"),
      h("button", { class: "link", onclick: () => send({ type: "copySha", pk: s.pk }) }, "Copy SHA"));
  }

  function suiteView(sub, suite) {
    const failing = suite.total_points < suite.total_points_possible;
    return h("details", { class: "suite", open: failing || results.ag_test_suite_results.length === 1 },
      h("summary", {},
        h("span", { class: "dot " + cls(suite.total_points, suite.total_points_possible) }),
        h("span", { class: "name" }, suite.ag_test_suite_name),
        h("span", { class: "pts" }, fmtPts(suite.total_points, suite.total_points_possible))),
      suite.student_description ? h("p", { class: "desc" }, suite.student_description) : null,
      suite.setup_return_code != null && suite.setup_return_code !== 0
        ? h("div", { class: "setup fail" }, `${suite.setup_name || "Setup"} exited with code ${suite.setup_return_code}`, suite.setup_timed_out ? " (timed out)" : "",
            (suite.fdbk_settings.show_setup_stdout || suite.fdbk_settings.show_setup_stderr)
              ? outputToggle(`setup-${suite.pk}`, () => send({ type: "setupOutput", pk: sub.pk, suitePk: suite.pk, key: `setup-${suite.pk}` })) : null,
            outputBox(`setup-${suite.pk}`))
        : null,
      suite.ag_test_case_results.map((c) => caseView(sub, c)));
  }

  function caseView(sub, c) {
    const multi = c.ag_test_command_results.length > 1;
    const failing = c.total_points < c.total_points_possible;
    const body = c.ag_test_command_results.map((cmd) => commandView(sub, cmd, multi));
    return h("details", { class: "case", open: failing && hasVisibleOutput(c) },
      h("summary", {},
        h("span", { class: "icon " + cls(c.total_points, c.total_points_possible) }, c.total_points_possible === 0 ? "•" : failing ? "✗" : "✓"),
        h("span", { class: "name" }, c.ag_test_case_name),
        h("span", { class: "pts" }, fmtPts(c.total_points, c.total_points_possible))),
      c.student_description ? h("p", { class: "desc" }, c.student_description) : null,
      body);
  }

  // Same rule as the server: `expected_and_actual` feedback also shows the actual output (and a diff).
  const canSee = (cmd, stream) => cmd.fdbk_settings[`show_actual_${stream}`] || cmd.fdbk_settings[`${stream}_fdbk_level`] === "expected_and_actual";
  const hasDiff = (cmd) => cmd.fdbk_settings.stdout_fdbk_level === "expected_and_actual" || cmd.fdbk_settings.stderr_fdbk_level === "expected_and_actual";
  const hasVisibleOutput = (c) => c.ag_test_command_results.some((x) => canSee(x, "stdout") || canSee(x, "stderr"));

  function commandView(sub, cmd, showName) {
    const key = `cmd-${cmd.pk}`;
    const checks = [];
    if (cmd.timed_out) checks.push(h("span", { class: "chip fail" }, "timed out"));
    if (cmd.return_code_correct === false) checks.push(h("span", { class: "chip fail" },
      "exit code", cmd.actual_return_code != null ? ` ${cmd.actual_return_code}` : "", cmd.expected_return_code != null ? ` (expected ${cmd.expected_return_code})` : " ✗"));
    if (cmd.stdout_correct === false) checks.push(h("span", { class: "chip fail" }, "stdout ✗"));
    if (cmd.stderr_correct === false) checks.push(h("span", { class: "chip fail" }, "stderr ✗"));
    const canShow = canSee(cmd, "stdout") || canSee(cmd, "stderr");
    outputCmd[key] = { pk: sub.pk, cmdPk: cmd.pk };
    return h("div", { class: "cmd" },
      h("div", { class: "row" },
        showName ? h("span", { class: "name" }, cmd.ag_test_command_name) : h("span", { class: "spacer" }),
        checks,
        canShow ? outputToggle(key, () => send({ type: "output", pk: sub.pk, cmdPk: cmd.pk, key }),
                               hasDiff(cmd) ? "Output & diff" : "Output")
                : h("span", { class: "muted small" }, "output hidden")),
      cmd.student_on_fail_description && cmd.total_points < cmd.total_points_possible
        ? h("p", { class: "desc" }, cmd.student_on_fail_description) : null,
      outputBox(key));
  }

  function outputBox(key) {
    const box = h("div", { class: "output", id: key, hidden: !openKeys.has(key) });
    if (outputs[key]) fillOutputInto(box, outputs[key].stdout, outputs[key].stderr, outputs[key].diffs);
    return box;
  }

  function outputToggle(key, load, label = "Output") {
    return h("button", { class: "link", onclick: (e) => {
      e.preventDefault();
      const box = document.getElementById(key);
      if (!box) return;
      if (openKeys.has(key)) { openKeys.delete(key); box.hidden = true; return; }
      openKeys.add(key); box.hidden = false;
      if (!box.dataset.loaded) { box.textContent = "Loading output…"; load(); }
    } }, label);
  }

  function mutationView(m) {
    const exposed = m.bugs_exposed || [];
    const all = m.all_bug_names;
    return h("details", { class: "suite", open: m.total_points < m.total_points_possible },
      h("summary", {},
        h("span", { class: "dot " + cls(m.total_points, m.total_points_possible) }),
        h("span", { class: "name" }, m.mutation_test_suite_name),
        h("span", { class: "pts" }, fmtPts(m.total_points, m.total_points_possible))),
      h("div", { class: "mut" },
        m.num_bugs_exposed != null && h("p", {}, `Bugs exposed: ${m.num_bugs_exposed}${all ? ` of ${all.length}` : ""}`),
        exposed.length ? h("p", { class: "small" }, "Exposed: ", exposed.join(", ")) : null,
        m.student_tests && m.student_tests.length ? h("p", { class: "small muted" }, "Your tests: ", m.student_tests.join(", ")) : null,
        m.discarded_tests && m.discarded_tests.length ? h("p", { class: "small" }, "Discarded (over limit): ", m.discarded_tests.join(", ")) : null,
        m.invalid_tests && m.invalid_tests.length ? h("p", { class: "small fail-text" }, "Invalid (failed on correct code): ", m.invalid_tests.join(", ")) : null,
        m.timed_out_tests && m.timed_out_tests.length ? h("p", { class: "small fail-text" }, "Timed out: ", m.timed_out_tests.join(", ")) : null));
  }

  function fillOutput(key, stdout, stderr, diffs) {
    outputs[key] = { stdout, stderr, diffs };
    const box = document.getElementById(key);
    if (box) fillOutputInto(box, stdout, stderr, diffs);
  }

  function refillOutput(key) {
    const box = document.getElementById(key), o = outputs[key];
    if (box && o) fillOutputInto(box, o.stdout, o.stderr, o.diffs);
  }

  function fillOutputInto(box, stdout, stderr, diffs) {
    box.dataset.loaded = "1";
    const key = box.id;
    const pane = (label, segs) => {
      const diff = diffs && diffs[label];
      if (!segs.length && !diff) return null;
      // A test graded against expected output: show the diff (default when they differ) or the raw output.
      const vk = `${key}:${label}`;
      const mode = diff ? (streamView[vk] || (diff.items.length ? "diff" : "output")) : "output";
      const tabs = diff && h("span", { class: "tabs" },
        ["diff", "output"].map((m) => h("button", { class: "tab" + (mode === m ? " on" : ""),
          onclick: () => { streamView[vk] = m; refillOutput(key); } }, m === "diff" ? "Diff" : "Output")));
      const body = mode === "diff" ? diffView(key, label, diff) : outputPre(segs);
      return h("div", { class: "stream" }, h("div", { class: "label" }, label, tabs), body);
    };
    const a = pane("stdout", stdout), b = pane("stderr", stderr);
    box.replaceChildren(...[a, b].filter(Boolean));
    if (!a && !b) box.textContent = "(no output)";
  }

  function outputPre(segs) {
    const pre = h("pre", {});
    if (!segs.length) pre.append(h("span", { class: "muted" }, "(empty)"));
    for (const s of segs) {
      if (!s.link) { pre.append(document.createTextNode(s.t)); continue; }
      const open = (e) => { e.preventDefault(); send({ type: "open", link: s.link }); };
      pre.append(h("a", { href: "#", title: s.title, onclick: open }, s.t));
      if (s.hint) pre.append(h("a", { href: "#", class: "hint", title: s.title, onclick: open }, ` → ${s.hint}`));
    }
    return pre;
  }

  // ---- expected-vs-actual diff ---------------------------------------------
  // `diff` is a DiffView from src/diff.ts: rows aligned side by side, unchanged runs collapsed.

  function diffView(key, stream, diff) {
    const c = outputCmd[key];
    const bar = h("div", { class: "diffbar" },
      diff.items.length
        ? h("span", { class: "legend" },
            h("span", { class: "del-text" }, `− expected (${diff.removed})`), " ",
            h("span", { class: "add-text" }, `+ yours (${diff.added})`))
        : h("span", { class: "pass-text" }, "✓ Matches the expected output"),
      h("span", { class: "spacer" }),
      h("label", { class: "small", title: "Show spaces (·), tabs (→) and line ends (↵)" },
        h("input", { type: "checkbox", checked: prefs.showWs, onchange: (e) => {
          prefs.showWs = e.target.checked;
          vscode.setState(Object.assign({}, vscode.getState(), { prefs }));
          Object.keys(outputs).forEach(refillOutput);
        } }), " Show whitespace"),
      c && h("button", { class: "link", title: "Open the expected output next to your real output in VS Code's diff editor. The diff in this panel is autograder.io's own, which is what's graded: VS Code ignores leading/trailing whitespace by default, so a stray space may only show up here.",
        onclick: () => send({ type: "openDiff", pk: c.pk, cmdPk: c.cmdPk, stream }) }, "Open in diff editor"));
    if (!diff.items.length) return h("div", { class: "diff" }, bar);
    const split = wide.matches;
    // Fixed layout takes column widths from the first row, so pin the gutters with a colgroup.
    const table = h("table", { class: "difftable " + (split ? "split" : "unified") },
      h("colgroup", {}, split
        ? [h("col", { class: "gutter" }), h("col", {}), h("col", { class: "gutter" }), h("col", {})]
        : [h("col", { class: "gutter" }), h("col", { class: "gutter" }), h("col", {})]));
    if (split) table.append(h("tr", {}, h("th", { colspan: 2 }, "Expected"), h("th", { colspan: 2 }, "Yours")));
    appendItems(table, diff.items, split, `${key}:${stream}`);
    return h("div", { class: "diff" }, bar,
      h("div", { class: "diffscroll" }, table),
      diff.truncated && h("div", { class: "muted small" }, "Diff truncated. Open it in the diff editor to see everything."));
  }

  function appendItems(table, items, split, id) {
    let pending = [];   // a run of changed rows; unified view lists all removals, then all additions
    const flush = () => {
      if (!pending.length) return;
      if (split) pending.forEach((r) => table.append(splitRow(r)));
      else {
        pending.forEach((r) => r.exp && table.append(uniRow("-", r.exp.n, "", r.exp)));
        pending.forEach((r) => r.act && table.append(uniRow("+", "", r.act.n, r.act)));
      }
      pending = [];
    };
    for (const it of items) {
      if (it.skip) {
        flush();
        const skipId = `${id}:${it.skip[0].exp.n}`;
        if (expanded.has(skipId)) { appendItems(table, it.skip, split, id); continue; }
        const tr = h("tr", { class: "skip" }, h("td", { colspan: split ? 4 : 3 },
          h("button", { class: "link", onclick: () => {
            expanded.add(skipId);
            const frag = document.createDocumentFragment();
            appendItems(frag, it.skip, split, id);
            tr.replaceWith(frag);
          } }, `⋯ ${it.skip.length} unchanged line${it.skip.length === 1 ? "" : "s"}`)));
        table.append(tr);
      } else if (it.same) {
        flush();
        table.append(split ? splitRow(it) : uniRow(" ", it.exp.n, it.act.n, it.exp));
      } else pending.push(it);
    }
    flush();
  }

  function splitRow(r) {
    const cell = (side, kind, extra) => side
      ? [h("td", { class: "n " + kind }, String(side.n)), h("td", { class: `t ${kind} ${extra}` }, lineText(side, kind))]
      : [h("td", { class: "n empty" }), h("td", { class: `t empty ${extra}` })];
    return h("tr", {}, cell(r.exp, r.same ? "same" : "del", "mid"), cell(r.act, r.same ? "same" : "add", ""));
  }

  function uniRow(sign, nExp, nAct, side) {
    const kind = sign === "-" ? "del" : sign === "+" ? "add" : "same";
    return h("tr", {},
      h("td", { class: "n " + kind }, String(nExp)), h("td", { class: "n " + kind }, String(nAct)),
      h("td", { class: "t " + kind }, h("span", { class: "sign" }, sign === " " ? " " : sign === "-" ? "−" : "+"), lineText(side, kind)));
  }

  /** A line's text with the differing span highlighted and (optionally) whitespace made visible. */
  function lineText(side, kind) {
    const frag = document.createDocumentFragment();
    const put = (str, hl) => {
      if (!str) return;
      const target = hl ? h("span", { class: "hl" }) : frag;
      // A carriage return is invisible but always meaningful here (Windows line endings), so always mark it.
      const ws = prefs.showWs ? /([ \t\r]+)/ : /(\r+)/;
      str.split(ws).forEach((part, i) => {
        if (!part) return;
        if (i % 2) target.append(h("span", { class: "ws" }, part.replace(/ /g, "·").replace(/\t/g, "→\t").replace(/\r/g, "␍")));
        else target.append(document.createTextNode(part));
      });
      if (hl) frag.append(target);
    };
    const t = side.text;
    if (side.hl && kind !== "same") {
      const [a, b] = side.hl;
      put(t.slice(0, a)); put(t.slice(a, b), true); put(t.slice(b));
    } else put(t);
    if (!side.eol) frag.append(h("span", { class: "ws noeol", title: "This is the last line and it has no newline at the end" }, " ⌀ no newline at end"));
    else if (prefs.showWs) frag.append(h("span", { class: "ws" }, "↵"));
    return frag;
  }

  wide.addEventListener("change", () => Object.keys(outputs).forEach(refillOutput));

  // ---- messages -----------------------------------------------------------
  window.addEventListener("message", (e) => {
    const m = e.data;
    switch (m.type) {
      case "loading":
        if (!state) app.replaceChildren(h("div", { class: "empty" }, "Loading…"));
        break;
      case "signedOut":
        app.replaceChildren(h("div", { class: "empty" },
          h("p", {}, "Sign in to autograder.io to see your submissions."),
          h("button", { class: "primary", onclick: () => send({ type: "signIn" }) }, "Sign in")));
        break;
      case "error":
        app.prepend(h("div", { class: "error" }, m.message));
        break;
      case "state":
        state = m;
        if (!state.submissions.some((s) => s.pk === selected)) { selected = null; results = null; }
        render();
        break;
      case "selected":
        selected = m.pk; render();
        break;
      case "results":
        if (m.pk !== selected) break;
        results = m.results; scores[m.pk] = m.score; render();
        break;
      case "score":
        scores[m.pk] = m.score;
        if (state) { const nav = document.querySelector("nav"); if (nav) nav.replaceWith(sidebar()); }
        break;
      case "output":
        fillOutput(m.key, m.stdout, m.stderr, m.diffs);
        break;
    }
  });

  send({ type: "ready" });
})();
