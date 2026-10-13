#!/usr/bin/env node
// A read-only fake of the autograder.io REST API with fictional data, for demos and UI work.
//   node demo/mock-server.mjs /tmp/ag-demo        (after demo/setup.mjs)
// Accepts any token. Every write (POST/PATCH/DELETE) is refused, so nothing can be "submitted".
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

const dir = path.resolve(process.argv[2] ?? "/tmp/ag-demo");
const PORT = Number(process.env.PORT ?? 4785);
const meta = JSON.parse(fs.readFileSync(path.join(dir, ".git", "ag-demo.json"), "utf8"));
const at = (minutesAgo) => new Date(meta.createdAt - minutesAgo * 60000).toISOString();

const user = { pk: 1, username: "student@example.edu", first_name: "Demo", last_name: "Student", email: "student@example.edu", is_superuser: false };
const course = { pk: 1, name: "CS 101 (demo)", semester: "Fall", year: 2026 };
const project = {
  pk: 101, name: "Project 2 – Recipe Box", course: 1, visible_to_students: true, timezone: "America/Detroit",
  soft_closing_time: new Date(meta.createdAt + 3 * 86400000 + 5 * 3600000).toISOString(),
  disallow_student_submissions: false, min_group_size: 1, max_group_size: 1,
  submission_limit_per_day: 3, allow_submissions_past_limit: false, num_bonus_submissions: 0, total_submission_limit: null,
  expected_student_files: [{ pk: 1, project: 101, pattern: "submit.tar.gz", min_num_matches: 1, max_num_matches: 1 }],
  use_honor_pledge: true, honor_pledge_text: "I have neither given nor received unauthorized aid on this project.",
};
const group = { pk: 11, project: 101, member_names: [user.username], members: [], extended_due_date: null,
  bonus_submissions_remaining: 0, late_days_used: {}, num_submissions: 4, num_submits_towards_limit: 2 };

const sub = (pk, minutesAgo) => ({
  pk, group: 11, timestamp: at(minutesAgo), submitter: user.username, submitted_filenames: ["submit.tar.gz"],
  discarded_files: [], missing_files: {}, status: "finished_grading", is_past_daily_limit: false,
  is_bonus_submission: false, count_towards_total_limit: true, does_not_count_for: [], position_in_queue: 0,
});
const submissions = [sub(1004, 20), sub(1003, 120), sub(1002, 60 * 23), sub(1001, 60 * 45)];

// ---- tests ----------------------------------------------------------------
const PUBLIC = [
  ["test_home_page_public", "home page lists saved recipes", 4],
  ["test_recipe_detail_public", "opening a recipe shows its ingredients", 4],
  ["test_search_public", "search filters by ingredient", 4],
  ["test_layout_public", "header and search bar render", 3],
  ["test_api_recipe_public", "GET /api/recipes/<id>", 3],
  ["test_units_public", "amounts are rounded to 2 decimals", 2],
  ["test_export_public", "recipe export matches the expected output", 4],
];
const PROTECTED = [
  ["test_api_private", 12], ["test_add_recipe_private", 8], ["test_search_private", 10],
  ["test_units_private", 6], ["test_edit_recipe_private", 9], ["test_delete_private", 7],
];
// Which tests fail in which submission (the story: crash → fixed → polishing).
const FAILS = {
  1001: ["test_export_public", "test_home_page_public", "test_recipe_detail_public", "test_search_public", "test_layout_public", "test_api_recipe_public", "test_units_public",
         "test_api_private", "test_add_recipe_private", "test_search_private", "test_units_private", "test_edit_recipe_private"],
  1002: ["test_export_public", "test_home_page_public", "test_recipe_detail_public", "test_api_recipe_public", "test_api_private", "test_add_recipe_private", "test_edit_recipe_private", "test_delete_private"],
  1003: ["test_export_public", "test_home_page_public", "test_recipe_detail_public", "test_api_recipe_public", "test_api_private", "test_add_recipe_private"],
  1004: ["test_add_recipe_private", "test_units_private"],
};

const crashFrame = `http://localhost:3000/dist/app.js:${meta.crash.line}:${meta.crash.column}`;
function browserTestOutput(desc, crash) {
  return `Starting server: python3 -m server --port 3000
Waiting for http://127.0.0.1:3000/ ... ready

Running 1 test using 1 worker

  ✘  1 [chromium] › recipes.spec.js › ${desc} (2.1s)

  1) [chromium] › recipes.spec.js › ${desc} ─────────────────────────────

    ${crash ? `Error: page error: TypeError: Cannot read properties of undefined (reading 'title')

        at RecipeBox (${crashFrame})
        at renderComponent (http://localhost:3000/dist/app.js:8419:22)
        at mountChildren (http://localhost:3000/dist/app.js:10923:19)
` : `Error: Timed out 5000ms waiting for expect(locator).toBeVisible()

    Locator: getByRole('listitem').filter({ hasText: 'cups' })
`}
  1 failed
`;
}
const pytestOutput = `============================= test session starts ==============================
collected 1 item

tests/test_api_recipe_public.py F                                         [100%]

=================================== FAILURES ===================================
_______________________________ test_get_recipe ________________________________

client = <TestClient for server>

    def test_get_recipe(client):
        response = client.get("/api/recipes/7")
>       assert response.status_code == 200
E       assert 500 == 200

tests/test_api_recipe_public.py:18: AssertionError
=========================== short test summary info ============================
FAILED tests/test_api_recipe_public.py::test_get_recipe - assert 500 == 200
`;
const pyTraceback = `ERROR in server: Exception on /api/recipes/7 [GET]
Traceback (most recent call last):
  File "/usr/local/lib/python3.12/site-packages/server_runtime/app.py", line 211, in dispatch
    return handler(**args)
  File "/home/autograder/working_dir/submit/server/routes.py", line ${meta.pyLine}, in get_recipe
    return {"id": row["id"], "title": row["title"], "minutes": row["time"],
IndexError: No item with that key
`;

// test_export_public is graded like EECS 280's .correct files: stdout vs. an expected output.
const ingredients = [[1.5, "cups", "flour"], [2, "tbsp", "sugar"], [2, "tsp", "baking powder"], [0.25, "tsp", "salt"],
  [1.25, "cups", "milk"], [2, "", "eggs"], [3, "tbsp", "butter"], [1, "tsp", "vanilla"], [0.75, "cups", "blueberries"],
  [0.5, "cups", "maple syrup"]];
const steps = ["Whisk the dry ingredients.", "Melt the butter.", "Whisk milk, eggs, butter and vanilla.",
  "Fold wet into dry; leave it lumpy.", "Rest the batter 5 minutes.", "Heat a griddle to medium.",
  "Pour 1/4 cup per pancake.", "Scatter blueberries on top.", "Flip when bubbles form.", "Cook 1 more minute.",
  "Keep warm in a low oven.", "Serve with maple syrup."];
function exportOutput(rounded) {
  const fmt = (q) => (rounded || String(q).length !== 3 ? q.toFixed(2) : String(q));   // the bug: "1.5", not "1.50"
  return [
    "./recipes export --format=text pancakes",
    "Blueberry Pancakes (serves 4)",
    "Ingredients:",
    ...ingredients.map(([q, unit, name]) => `  ${fmt(q)} ${unit ? unit + " " : ""}${name}`),
    rounded ? "Steps:" : "Steps: ",
    ...steps.map((st, i) => `  ${i + 1}. ${st}`),
    "Total time: 25 min",
  ].join("\n") + (rounded ? "\n" : "");
}
const expectedExport = exportOutput(true);
// The student's version doesn't echo the command, rounds wrong, and has a stray space and no final newline.
const actualExport = exportOutput(false).split("\n").slice(1).join("\n");

/** Same shape as autograder.io's stdout_diff: "  " / "- " (expected) / "+ " (actual) + line incl. "\n". */
function lineDiff(a, b) {
  const split = (t) => (t.match(/[^\n]*\n|[^\n]+$/g) ?? []);
  const x = split(a), y = split(b);
  const L = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--)
    L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { out.push("  " + x[i++]); j++; }
    else if (j < y.length && (i === x.length || L[i][j + 1] > L[i + 1][j])) out.push("+ " + y[j++]);
    else out.push("- " + x[i++]);
  }
  return out;
}

function outputFor(subPk, testName, desc, stream) {
  if (testName === "test_export_public") return stream === "stdout" ? (subPk <= 1003 ? actualExport : expectedExport) : "";
  if (testName === "test_api_recipe_public") return stream === "stdout" ? pytestOutput : pyTraceback;
  const crash = subPk <= 1003 && (testName === "test_home_page_public" || testName === "test_recipe_detail_public");
  return stream === "stdout" ? browserTestOutput(desc, crash) : "";
}

const visible = { visible: true, show_actual_stdout: true, show_actual_stderr: true, stdout_fdbk_level: "correct_or_incorrect", stderr_fdbk_level: "correct_or_incorrect", return_code_fdbk_level: "correct_or_incorrect", show_points: true };
const hidden = { ...visible, show_actual_stdout: false, show_actual_stderr: false };
// Only the diff grants output: show_actual_stdout stays false, as on many real projects.
const compared = { ...hidden, stdout_fdbk_level: "expected_and_actual" };
const cmdIndex = new Map();   // cmd pk → {sub, test, desc}

function results(subPk) {
  const fails = new Set(FAILS[subPk] ?? []);
  let n = 0;
  const mkCase = (name, desc, pts, fdbk) => {
    const ok = !fails.has(name);
    const pk = subPk * 100 + n++;
    cmdIndex.set(pk, { sub: subPk, test: name, desc });
    return {
      pk: pk + 50000, ag_test_case_name: name, ag_test_case_pk: n, fdbk_settings: { visible: true }, student_description: "",
      total_points: ok ? pts : 0, total_points_possible: pts,
      ag_test_command_results: [{
        pk, ag_test_command_pk: n, ag_test_command_name: desc, fdbk_settings: fdbk, student_description: "",
        student_on_fail_description: null, timed_out: false, return_code_correct: ok, expected_return_code: null,
        actual_return_code: null, return_code_points: ok ? pts : 0, return_code_points_possible: pts,
        stdout_correct: fdbk === compared ? ok : null, stdout_points: 0, stdout_points_possible: 0, stderr_correct: null, stderr_points: 0, stderr_points_possible: 0,
        custom_scoring_used: false, total_points: ok ? pts : 0, total_points_possible: pts,
      }],
    };
  };
  const pub = PUBLIC.map(([name, desc, pts]) => mkCase(name, desc, pts, name === "test_export_public" ? compared : visible));
  const prot = PROTECTED.map(([name, pts]) => mkCase(name, name, pts, hidden));
  const sum = (cs, k) => cs.reduce((a, c) => a + c[k], 0);
  const suite = (pk, name, cases) => ({
    pk, ag_test_suite_name: name, ag_test_suite_pk: pk, fdbk_settings: { visible: true, show_individual_tests: true, show_setup_stdout: false, show_setup_stderr: false },
    student_description: "", total_points: sum(cases, "total_points"), total_points_possible: sum(cases, "total_points_possible"),
    setup_name: "Setup", setup_return_code: 0, setup_timed_out: false, ag_test_case_results: cases,
  });
  const exposed = { 1001: 1, 1002: 2, 1003: 3, 1004: 4 }[subPk] ?? 0;
  const bugs = ["bug_wrong_sort_order", "bug_search_case_sensitive", "bug_unit_rounding", "bug_delete_wrong_recipe", "bug_empty_title_allowed"];
  const mutation = {
    pk: subPk * 10, mutation_test_suite_name: "Mutation Testing", mutation_test_suite_pk: 1, fdbk_settings: {},
    has_setup_command: false, student_tests: ["test_student"], discarded_tests: [], invalid_tests: [], timed_out_tests: [],
    num_bugs_exposed: exposed, bugs_exposed: bugs.slice(0, exposed), all_bug_names: bugs, total_points: exposed * 2, total_points_possible: 10,
  };
  const suites = [suite(1, "Public Tests", pub), suite(2, "Protected Tests", prot)];
  const total = sum(suites, "total_points") + mutation.total_points;
  const possible = sum(suites, "total_points_possible") + mutation.total_points_possible;
  return { pk: subPk, total_points: total.toFixed(2), total_points_possible: possible.toFixed(2), ag_test_suite_results: suites, mutation_test_suite_results: [mutation] };
}
submissions.forEach((s) => results(s.pk));   // populate cmdIndex

// ---- routing ----------------------------------------------------------------
const routes = [
  [/^\/api\/users\/current\/$/, () => user],
  [/^\/api\/users\/1\/courses_is_enrolled_in\/$/, () => [course]],
  [/^\/api\/courses\/1\/projects\/$/, () => [project]],
  [/^\/api\/projects\/101\/$/, () => project],
  [/^\/api\/users\/1\/groups_is_member_of\/$/, () => [group]],
  [/^\/api\/groups\/11\/submissions\/$/, () => submissions],
  [/^\/api\/submissions\/(\d+)\/$/, (m) => submissions.find((s) => s.pk === +m[1])],
  [/^\/api\/submissions\/(\d+)\/results\/$/, (m) => results(+m[1])],
  [/^\/api\/submissions\/(\d+)\/ag_test_cmd_results\/(\d+)\/(stdout|stderr)\/$/, (m) => {
    const c = cmdIndex.get(+m[2]);
    return c ? { text: outputFor(c.sub, c.test, c.desc, m[3]) } : undefined;
  }],
  [/^\/api\/submissions\/(\d+)\/ag_test_cmd_results\/(\d+)\/(stdout|stderr)_diff\/$/, (m) => {
    const c = cmdIndex.get(+m[2]);
    if (!c) return undefined;
    // Like the server: no expected output (or not shown) → an empty body, not JSON.
    if (c.test !== "test_export_public" || m[3] !== "stdout") return { text: "" };
    return lineDiff(expectedExport, outputFor(c.sub, c.test, c.desc, "stdout"));
  }],
  [/^\/api\/submissions\/(\d+)\/ag_test_suite_results\/(\d+)\/(stdout|stderr)\/$/, () => ({ text: "" })],
  [/^\/api\/submissions\/(\d+)\/file\/$/, () => ({ file: path.join(dir, "submit.tar.gz") })],
];

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (status, body, type = "application/json") => {
    res.writeHead(status, { "Content-Type": type });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  if (!/^Token \S+/.test(req.headers.authorization ?? "")) return send(401, { detail: "Authentication credentials were not provided." });
  if (req.method !== "GET") return send(405, { detail: "This is a read-only demo server; nothing can be submitted." });
  for (const [re, fn] of routes) {
    const m = url.pathname.match(re);
    if (!m) continue;
    const out = fn(m);
    if (out === undefined) return send(404, { detail: "Not found." });
    if (out.text !== undefined) return send(200, out.text, "text/plain; charset=utf-8");
    if (out.file) return send(200, fs.readFileSync(out.file), "application/octet-stream");
    return send(200, out);
  }
  send(404, { detail: "Not found." });
}).listen(PORT, "127.0.0.1", () => console.log(`Mock autograder.io on http://127.0.0.1:${PORT} (demo data from ${dir})`));
