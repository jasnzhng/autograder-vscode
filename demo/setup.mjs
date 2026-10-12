#!/usr/bin/env node
// Creates a fictional student project ("Recipe Box": a bundled JSX front end + a small Python
// server) for demos, screenshots and UI work:
//   node demo/setup.mjs /tmp/ag-demo
// Then run the mock server (demo/mock-server.mjs) and open the folder with the extension.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const dir = path.resolve(process.argv[2] ?? "/tmp/ag-demo");
const here = path.dirname(fileURLToPath(import.meta.url));
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const write = (rel, text) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text.replace(/^\n/, ""));
};
const edit = (rel, fn) => fs.writeFileSync(path.join(dir, rel), fn(fs.readFileSync(path.join(dir, rel), "utf8")));
const now = Date.now();
const at = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const commit = (minutesAgo, msg) => execFileSync("git", ["commit", "-qam", msg], {
  cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: at(minutesAgo), GIT_COMMITTER_DATE: at(minutesAgo) } });

const BUILD = "COPYFILE_DISABLE=1 tar -czf submit.tar.gz --exclude='*__pycache__*' web server tests/my_tests.spec.js";

// ---- v1 -----------------------------------------------------------------
write(".gitignore", `
.vscode/
web/dist/
*.js.map
submit.tar.gz
__pycache__/
`);
write(".vscode/settings.json", JSON.stringify({
  "autograder.projectId": 101,
  "autograder.baseUrl": "http://127.0.0.1:4785",
  "autograder.dryRun": true,
  "autograder.buildCommand": BUILD,
}, null, 2) + "\n");
write("server/__init__.py", '"""Recipe Box API server."""\n');
write("server/routes.py", `
"""JSON API for recipes."""
from server.db import query


def list_recipes():
    return [dict(r) for r in query("SELECT id, title, minutes FROM recipes")]


def get_recipe(recipe_id):
    row = query("SELECT * FROM recipes WHERE id = ?", (recipe_id,), one=True)
    ingredients = query("SELECT * FROM ingredients WHERE recipe = ?", (recipe_id,))
    # BUG: the column is "minutes", not "time"
    return {"id": row["id"], "title": row["title"], "minutes": row["time"],
            "ingredients": [dict(i) for i in ingredients]}
`);
write("server/db.py", `
import sqlite3

_conn = sqlite3.connect("var/recipes.sqlite3", check_same_thread=False)
_conn.row_factory = sqlite3.Row


def query(sql, args=(), one=False):
    rows = _conn.execute(sql, args).fetchall()
    return (rows[0] if rows else None) if one else rows
`);
write("web/src/runtime.js", `
// Tiny JSX runtime so the demo bundles without React.
export function h(type, props, ...children) {
  return typeof type === "function" ? type({ ...props, children }) : { type, props, children };
}
`);
write("web/src/IngredientList.jsx", `
import { h } from "./runtime";

export default function IngredientList({ ingredients }) {
  return (
    <ul className="ingredients">
      {ingredients.map((i) => (
        <li key={i.id}>{i.amount} {i.unit} {i.name}</li>
      ))}
    </ul>
  );
}
`);
write("web/src/App.jsx", `
import { h } from "./runtime";
import IngredientList from "./IngredientList";

function SearchBar({ onSearch }) {
  return (
    <form className="search" onSubmit={(e) => onSearch(e.target.q.value)}>
      <input name="q" placeholder="Search by ingredient" />
    </form>
  );
}

export default function RecipeBox({ recipes, selectedId }) {
  const selected = recipes.find((r) => r.id === selectedId);
  // Breaks when nothing is selected yet:
  const heading = \`\${selected.title} · \${selected.minutes} min\`;
  return (
    <main>
      <SearchBar onSearch={() => {}} />
      <h1>{heading}</h1>
      <IngredientList ingredients={[]} />
    </main>
  );
}
`);
write("tests/my_tests.spec.js", `
test("search box is visible", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByPlaceholder("Search by ingredient")).toBeVisible();
});
`);

git("init", "-q", "-b", "main");
git("config", "user.name", "Demo Student");
git("config", "user.email", "student@example.edu");
git("add", "-A");
commit(60 * 72, "Scaffold recipe box");

edit("web/src/IngredientList.jsx", (s) => s.replace("{i.amount} {i.unit} {i.name}", "{formatAmount(i)} {i.name}")
  .replace('import { h } from "./runtime";', 'import { h } from "./runtime";\n\nconst formatAmount = (i) => `${+i.amount.toFixed(2)} ${i.unit}`;'));
commit(60 * 47, "Ingredient list with unit formatting");
edit("server/routes.py", (s) => s + '\n\ndef search(term):\n    return query("SELECT * FROM recipes WHERE title LIKE ?", (f"%{term}%",))\n');
commit(60 * 24, "Search endpoint");

// ---- build the bundle the way a typical web course setup would --------------
esbuild.buildSync({
  entryPoints: [path.join(dir, "web/src/App.jsx")],
  bundle: true, sourcemap: true, format: "iife", globalName: "RecipeBox",
  jsxFactory: "h", outfile: path.join(dir, "web/dist/app.js"), logLevel: "silent", absWorkingDir: dir,
});
const bundle = fs.readFileSync(path.join(dir, "web/dist/app.js"), "utf8").split("\n");
const crashLine = bundle.findIndex((l) => l.includes("selected.title"));
const crash = { line: crashLine + 1, column: bundle[crashLine].indexOf("selected.title") + 1 };
const pyLine = fs.readFileSync(path.join(dir, "server/routes.py"), "utf8").split("\n").findIndex((l) => l.includes('row["time"]')) + 1;

// The tarball the autograder would have received (served back by the mock server).
execFileSync("sh", ["-c", BUILD], { cwd: dir });

// Fix after submission #1003, then a direct submit (#1004) with an uncommitted tweak → exact snapshot.
edit("web/src/App.jsx", (s) => s
  .replace("// Breaks when nothing is selected yet:", "// Nothing selected yet on first load:")
  .replace("const heading = `${selected.title} · ${selected.minutes} min`;",
           'const heading = selected ? `${selected.title} · ${selected.minutes} min` : "Pick a recipe";'));
commit(90, "Handle no recipe selected");
fs.appendFileSync(path.join(dir, "web/src/IngredientList.jsx"), "\n// TODO: scale servings\n");
const head = git("rev-parse", "HEAD");
const tmpIndex = path.join(dir, ".git", "ag-demo-index");
const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
execFileSync("git", ["add", "-A"], { cwd: dir, env });
const tree = execFileSync("git", ["write-tree"], { cwd: dir, env, encoding: "utf8" }).trim();
fs.rmSync(tmpIndex);
const snap = execFileSync("git", ["commit-tree", tree, "-p", head, "-m", "autograder: snapshot"], {
  cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: at(20), GIT_COMMITTER_DATE: at(20) } }).trim();
git("update-ref", "refs/autograder/submissions/1004", snap);
git("update-ref", "refs/autograder/submissions/1004-head", head);

fs.writeFileSync(path.join(dir, ".git", "ag-demo.json"), JSON.stringify({ crash, pyLine, createdAt: now }, null, 2));
console.log(`Demo workspace ready at ${dir}`);
console.log(`  bundle crash at app.js:${crash.line}:${crash.column}  (maps to web/src/App.jsx)`);
console.log(`  python bug at server/routes.py:${pyLine}`);
console.log(`Next: node ${path.relative(process.cwd(), path.join(here, "mock-server.mjs"))} ${dir}`);
