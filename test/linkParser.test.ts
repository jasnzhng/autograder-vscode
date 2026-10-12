import { test } from "node:test";
import assert from "node:assert/strict";
import { candidatePaths, findFileRefs, isNoise, looksBundled, messageNear, normalizeSourceMapSource, stripAnsi } from "../src/linkParser.ts";
import { chooseUploads, fnmatchToRegExp, matchExpected } from "../src/files.ts";

// Shaped like real autograder output from a browser-test harness (a bundled front end + Python server).
const WEB_STDOUT = `  1 failing

  1) Recipes
       shows saved recipes on the home page:
     TypeError: The following error originated from your application code, not from the test runner.

  > Cannot read properties of undefined (reading 'title')

When the runner detects uncaught errors originating from your application it will automatically fail the current test.

      at RecipeCard (http://localhost:3000/assets/app.js:1204:17)
      at Object.react_stack_bottom_frame (http://localhost:3000/assets/app.js:26661:20)
      at renderWithHooks (http://localhost:3000/assets/app.js:8419:22)`;
const WEB_STDERR = `+ EXPECTED=/home/autograder/working_dir/submit/server
    at makeError (/home/autograder/working_dir/node_modules/start-server-and-test/node_modules/execa/lib/error.js:60:11)`;

test("browser stack frames become bundle refs with line + column", () => {
  const refs = findFileRefs(WEB_STDOUT);
  assert.equal(refs.length, 3);
  assert.deepEqual({ ...refs[0], start: 0, end: 0 }, { start: 0, end: 0, rawPath: "/assets/app.js", line: 1204, column: 17 });
  assert.equal(WEB_STDOUT.slice(refs[0].start, refs[0].end), "http://localhost:3000/assets/app.js:1204:17");
  assert.ok(looksBundled(refs[0].rawPath));
  assert.equal(messageNear(WEB_STDOUT, refs[0].start), "TypeError: Cannot read properties of undefined (reading 'title')");
});

test("node_modules frames are found but flagged as noise", () => {
  const refs = findFileRefs(WEB_STDERR);
  assert.equal(refs.length, 1);
  assert.ok(isNoise(refs[0].rawPath));
});

test("python traceback", () => {
  const text = `Traceback (most recent call last):
  File "/home/autograder/working_dir/submit/server/views/accounts.py", line 87, in login
    raise ValueError("bad")
ValueError: bad`;
  const [ref] = findFileRefs(text);
  assert.equal(ref.rawPath, "/home/autograder/working_dir/submit/server/views/accounts.py");
  assert.equal(ref.line, 87);
  assert.deepEqual(candidatePaths(ref.rawPath), ["server/views/accounts.py", "views/accounts.py", "accounts.py"]);
  assert.equal(messageNear(text, ref.start), "ValueError: bad");
});

test("pytest short form and assertion message", () => {
  const text = `    def test_index(client):
>       assert response.status_code == 200
E       assert 500 == 200
tests/app_tests/test_index.py:23: AssertionError`;
  const [ref] = findFileRefs(text);
  assert.equal(ref.rawPath, "tests/app_tests/test_index.py");
  assert.equal(ref.line, 23);
  assert.equal(ref.column, undefined);
  assert.equal(messageNear(text, ref.start), "E       assert 500 == 200");
});

test("gcc/clang diagnostics, valgrind frames and assembler errors", () => {
  const text = `stack.cpp:42:17: error: 'node' was not declared in this scope
==123==    by 0x10A2B3: Queue::pop() (queue.cpp:58)
program.as(3) bad label`;
  const refs = findFileRefs(text);
  assert.deepEqual(refs.map((r) => [r.rawPath, r.line, r.column]), [
    ["stack.cpp", 42, 17],
    ["queue.cpp", 58, undefined],
    ["program.as", 3, undefined],
  ]);
});

test("ignores things that only look like refs", () => {
  assert.deepEqual(findFileRefs("listening on 127.0.0.1:8000, Node Version: v24.18.0"), []);
  assert.deepEqual(findFileRefs("config.json:12 and data.txt:4"), []);
});

test("webpack source names normalize to workspace paths", () => {
  assert.equal(normalizeSourceMapSource("webpack://myapp/./src/js/main.jsx"), "src/js/main.jsx");
  assert.equal(normalizeSourceMapSource("webpack:///./src/App.tsx?abc"), "src/App.tsx");
  assert.ok(isNoise(normalizeSourceMapSource("webpack://myapp/./node_modules/react-dom/cjs/react-dom.development.js")));
});

test("strips ANSI colors", () => {
  assert.equal(stripAnsi("\x1b[31mfailing\x1b[0m"), "failing");
});

test("fnmatch patterns from expected_student_files", () => {
  assert.ok(fnmatchToRegExp("submit.tar.gz").test("submit.tar.gz"));
  assert.ok(!fnmatchToRegExp("submit.tar.gz").test("submitXtarXgz"));
  assert.ok(fnmatchToRegExp("test_*.cpp").test("test_stack.cpp"));
  assert.ok(fnmatchToRegExp("p[12].cpp").test("p2.cpp"));
  assert.ok(!fnmatchToRegExp("p[!12].cpp").test("p2.cpp"));
});

test("chooses the shallowest match per pattern and reports missing files", () => {
  const files = ["submit.tar.gz", "old/submit.tar.gz", "stack.cpp", "tests/stack.cpp"];
  const { files: picked, problems } = chooseUploads(matchExpected(files, [
    { pattern: "submit.tar.gz", min_num_matches: 1, max_num_matches: 1 },
    { pattern: "stack.cpp", min_num_matches: 1, max_num_matches: 1 },
    { pattern: "queue.cpp", min_num_matches: 1, max_num_matches: 1 },
    { pattern: "*_tests.cpp", min_num_matches: 0, max_num_matches: 5 },
  ]));
  assert.deepEqual(picked, ["submit.tar.gz", "stack.cpp"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /queue\.cpp/);
});

import { buildArchiveCommand, inferArchiveRoots, isArchiveProject, normalizePastedCommand, pruneNested } from "../src/files.ts";

test("archive projects are detected from expected patterns", () => {
  assert.ok(isArchiveProject([{ pattern: "submit.tar.gz" }]));
  assert.ok(!isArchiveProject([{ pattern: "submit.tar.gz" }, { pattern: "stack.cpp" }]));
  assert.ok(!isArchiveProject([]));
});

test("infers tar roots from a tarball listing", () => {
  // `tar -tzf submit.tar.gz` after `tar -czf submit.tar.gz bin server sql tests/e2e/my_test.spec.js`.
  const listing = ["bin/", "bin/run", "bin/initdb", "server/", "server/__init__.py", "server/js/", "server/js/main.jsx",
    "server/static/js/app.js", "sql/", "sql/schema.sql", "tests/e2e/my_test.spec.js"];
  assert.deepEqual(inferArchiveRoots(listing), ["bin", "server", "sql", "tests/e2e/my_test.spec.js"]);
});

test("generated tar command", () => {
  assert.deepEqual(pruneNested(["server/js", "server", "bin/"]), ["bin", "server"]);
  assert.equal(buildArchiveCommand("submit.tar.gz", ["sql", "bin", "server", "tests/e2e/my_test.spec.js"], "darwin"),
    "COPYFILE_DISABLE=1 tar -czf submit.tar.gz --exclude='*__pycache__*' --exclude='.DS_Store' bin server sql tests/e2e/my_test.spec.js");
  assert.equal(buildArchiveCommand("p1.tar", ["my dir"], "linux"), "tar -cf p1.tar --exclude='*__pycache__*' --exclude='.DS_Store' 'my dir'");
});

test("pasted spec commands are tidied", () => {
  assert.equal(normalizePastedCommand("$ tar \\\n  --exclude '*__pycache__*' \\\n  -czvf submit.tar.gz \\\n  bin server"),
    "tar --exclude '*__pycache__*' -czvf submit.tar.gz bin server");
  assert.equal(normalizePastedCommand("$ npx webpack\n$ tar -czvf submit.tar.gz bin"), "npx webpack && tar -czvf submit.tar.gz bin");
});
