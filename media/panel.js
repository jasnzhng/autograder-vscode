// Webview UI for the Autograder panel. All server-provided text goes through textContent.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  let state = null;          // last "state" message
  let selected = null;       // selected submission pk
  let results = null;        // results for `selected`
  const scores = {};         // pk -> {points, possible}
  const openKeys = new Set(); // expanded command outputs, survive re-render
  const outputs = {};         // key -> {stdout, stderr} segments, survive re-render

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

  const hasVisibleOutput = (c) => c.ag_test_command_results.some((x) => x.fdbk_settings.show_actual_stdout || x.fdbk_settings.show_actual_stderr);

  function commandView(sub, cmd, showName) {
    const key = `cmd-${cmd.pk}`;
    const checks = [];
    if (cmd.timed_out) checks.push(h("span", { class: "chip fail" }, "timed out"));
    if (cmd.return_code_correct === false) checks.push(h("span", { class: "chip fail" },
      "exit code", cmd.actual_return_code != null ? ` ${cmd.actual_return_code}` : "", cmd.expected_return_code != null ? ` (expected ${cmd.expected_return_code})` : " ✗"));
    if (cmd.stdout_correct === false) checks.push(h("span", { class: "chip fail" }, "stdout ✗"));
    if (cmd.stderr_correct === false) checks.push(h("span", { class: "chip fail" }, "stderr ✗"));
    const canShow = cmd.fdbk_settings.show_actual_stdout || cmd.fdbk_settings.show_actual_stderr;
    return h("div", { class: "cmd" },
      h("div", { class: "row" },
        showName ? h("span", { class: "name" }, cmd.ag_test_command_name) : h("span", { class: "spacer" }),
        checks,
        canShow ? outputToggle(key, () => send({ type: "output", pk: sub.pk, cmdPk: cmd.pk, key }))
                : h("span", { class: "muted small" }, "output hidden")),
      cmd.student_on_fail_description && cmd.total_points < cmd.total_points_possible
        ? h("p", { class: "desc" }, cmd.student_on_fail_description) : null,
      outputBox(key));
  }

  function outputBox(key) {
    const box = h("div", { class: "output", id: key, hidden: !openKeys.has(key) });
    if (outputs[key]) fillOutputInto(box, outputs[key].stdout, outputs[key].stderr);
    return box;
  }

  function outputToggle(key, load) {
    return h("button", { class: "link", onclick: (e) => {
      e.preventDefault();
      const box = document.getElementById(key);
      if (!box) return;
      if (openKeys.has(key)) { openKeys.delete(key); box.hidden = true; return; }
      openKeys.add(key); box.hidden = false;
      if (!box.dataset.loaded) { box.textContent = "Loading output…"; load(); }
    } }, "Output");
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

  function fillOutput(key, stdout, stderr) {
    outputs[key] = { stdout, stderr };
    const box = document.getElementById(key);
    if (box) fillOutputInto(box, stdout, stderr);
  }

  function fillOutputInto(box, stdout, stderr) {
    box.dataset.loaded = "1";
    const pane = (label, segs) => {
      if (!segs.length) return null;
      const pre = h("pre", {});
      for (const s of segs) {
        if (!s.link) { pre.append(document.createTextNode(s.t)); continue; }
        const open = (e) => { e.preventDefault(); send({ type: "open", link: s.link }); };
        pre.append(h("a", { href: "#", title: s.title, onclick: open }, s.t));
        if (s.hint) pre.append(h("a", { href: "#", class: "hint", title: s.title, onclick: open }, ` → ${s.hint}`));
      }
      return h("div", { class: "stream" }, h("div", { class: "label" }, label), pre);
    };
    const a = pane("stdout", stdout), b = pane("stderr", stderr);
    box.replaceChildren(...[a, b].filter(Boolean));
    if (!a && !b) box.textContent = "(no output)";
  }

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
        fillOutput(m.key, m.stdout, m.stderr);
        break;
    }
  });

  send({ type: "ready" });
})();
