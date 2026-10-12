import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_SERVER, findDownloadedToken, isDownloadedTokenName, parseStoredToken, parseToken, readTokenFile, serverOrigin,
} from "../src/tokenFile.ts";

const TOKEN = "0123456789abcdef0123456789abcdef01234567";   // fake, 40 hex chars like a DRF token

test("recognizes the names browsers give the agtoken download", () => {
  for (const ok of ["agtoken", "agtoken (1)", "agtoken (12)", "agtoken-2", "agtoken.txt", "AGTOKEN"]) assert.ok(isDownloadedTokenName(ok), ok);
  for (const bad of ["agtoken.zip", "my agtoken", ".agtoken", "agtokens", "token"]) assert.ok(!isDownloadedTokenName(bad), bad);
});

test("parses the token file contents", () => {
  assert.equal(parseToken(TOKEN), TOKEN);
  assert.equal(parseToken(`  ${TOKEN}\n`), TOKEN);
  assert.equal(parseToken(`"${TOKEN}"`), TOKEN);
  assert.equal(parseToken("<!doctype html>"), undefined);
  assert.equal(parseToken(""), undefined);
});

test("finds the newest download, optionally only ones newer than a timestamp", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-dl-"));
  const older = "a".repeat(40), newer = "b".repeat(40);
  fs.writeFileSync(path.join(dir, "agtoken"), older);
  fs.utimesSync(path.join(dir, "agtoken"), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  fs.writeFileSync(path.join(dir, "agtoken (1)"), newer);
  fs.writeFileSync(path.join(dir, "notes.txt"), TOKEN);            // right contents, wrong name: ignored
  fs.writeFileSync(path.join(dir, "agtoken-2"), "not a token");    // right name, wrong contents: ignored

  assert.equal((await findDownloadedToken(dir))?.token, newer);
  const sinceStart = Date.now() - 5000;
  assert.equal((await findDownloadedToken(dir, sinceStart))?.file, path.join(dir, "agtoken (1)"));
  assert.equal(await findDownloadedToken(dir, Date.now() + 60000), undefined);
  assert.equal(await findDownloadedToken(path.join(dir, "missing")), undefined);
});

test("reads ~/.agtoken-style files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-home-"));
  fs.writeFileSync(path.join(dir, ".agtoken"), TOKEN + "\n");
  assert.equal((await readTokenFile(path.join(dir, ".agtoken")))?.token, TOKEN);
  assert.equal(await readTokenFile(path.join(dir, "nope")), undefined);
});

test("only https servers (or http on this machine) may receive the token", () => {
  assert.equal(serverOrigin(undefined), DEFAULT_SERVER);
  assert.equal(serverOrigin(""), DEFAULT_SERVER);
  assert.equal(serverOrigin("https://autograder.io/"), "https://autograder.io");
  assert.equal(serverOrigin("https://autograder.io/web/project/1"), "https://autograder.io");
  for (const local of ["http://127.0.0.1:4785", "http://localhost:8000/", "http://[::1]:4785"]) assert.ok(serverOrigin(local), local);
  for (const bad of ["http://autograder.io", "http://evil.example", "http://127.0.0.1.evil.example", "ftp://autograder.io",
    "javascript:alert(1)", "https://user:pw@autograder.io", "not a url"]) assert.equal(serverOrigin(bad), undefined, bad);
});

test("stored tokens remember their server; 0.1.x bare tokens belong to autograder.io", () => {
  assert.deepEqual(parseStoredToken(JSON.stringify({ token: TOKEN, origin: "http://127.0.0.1:4785" })),
    { token: TOKEN, origin: "http://127.0.0.1:4785" });
  assert.deepEqual(parseStoredToken(TOKEN), { token: TOKEN, origin: DEFAULT_SERVER });
  assert.deepEqual(parseStoredToken("1234567890123456789012345"), { token: "1234567890123456789012345", origin: DEFAULT_SERVER });
  assert.equal(parseStoredToken(undefined), undefined);
  assert.equal(parseStoredToken('{"token": 5}'), undefined);
});
