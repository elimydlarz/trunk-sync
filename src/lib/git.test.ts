import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  parseFileRef,
  extractSessionId,
  blame,
  getCommitBody,
  getCommitTimestamp,
  commandExists,
  shortSha,
  findSnapshotInCommit,
} from "./git.js";

describe("parseFileRef", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "git-test-"));
    file = join(dir, "test.txt");
    writeFileSync(file, "hello\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses valid file:line", () => {
    const result = parseFileRef(`${file}:1`);
    assert.equal(result.file, file);
    assert.equal(result.line, 1);
  });

  it("throws on missing colon", () => {
    assert.throws(() => parseFileRef("nocolon"), /Expected file:line/);
  });

  it("throws on non-numeric line", () => {
    assert.throws(() => parseFileRef(`${file}:abc`), /positive integer/);
  });

  it("throws on negative line", () => {
    assert.throws(() => parseFileRef(`${file}:-1`), /positive integer/);
  });

  it("throws on zero line", () => {
    assert.throws(() => parseFileRef(`${file}:0`), /positive integer/);
  });

  it("throws on file not found", () => {
    assert.throws(() => parseFileRef("/nonexistent/file.txt:1"), /File not found/);
  });
});

describe("extractSessionId", () => {
  it("extracts session ID from body", () => {
    const body = "File: src/main.ts\nSession: abc-123-def";
    assert.equal(extractSessionId(body), "abc-123-def");
  });

  it("returns null when no Session line", () => {
    assert.equal(extractSessionId("just some text"), null);
  });

  it("returns null for empty body", () => {
    assert.equal(extractSessionId(""), null);
  });
});

describe("blame and getCommitBody", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "git-blame-test-"));
    execSync("git init", { cwd: dir });
    execSync('git config user.email "test@test.com"', { cwd: dir });
    execSync('git config user.name "Test"', { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns commit SHA for a committed line", () => {
    const file = join(dir, "file.txt");
    writeFileSync(file, "line one\nline two\n");
    execSync("git add file.txt && git commit -m 'subject' -m 'Session: test-session-id'", {
      cwd: dir,
    });

    const result = blame(file, 1, dir);
    assert.match(result.sha, /^[0-9a-f]{40}$/);
    assert.equal(result.origLine, 1);

    const body = getCommitBody(result.sha, dir);
    assert.equal(extractSessionId(body), "test-session-id");
  });

  it("returns zeros for uncommitted lines", () => {
    const file = join(dir, "first.txt");
    writeFileSync(file, "committed\n");
    execSync("git add first.txt && git commit -m 'init'", { cwd: dir });

    writeFileSync(file, "committed\nuncommitted\n");
    const result = blame(file, 2, dir);
    assert.match(result.sha, /^0+$/);
  });

  it("returns original line number when lines are added above", () => {
    const file = join(dir, "file.txt");
    writeFileSync(file, "target line\n");
    execSync("git add file.txt && git commit -m 'first'", { cwd: dir });

    // Add two lines above, pushing 'target line' from line 1 to line 3
    writeFileSync(file, "new line A\nnew line B\ntarget line\n");
    execSync("git add file.txt && git commit -m 'second'", { cwd: dir });

    const result = blame(file, 3, dir);
    assert.equal(result.origLine, 1, "origLine should be 1 (where it was in the first commit)");
  });
});

describe("getCommitTimestamp", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "git-ts-test-"));
    execSync("git init", { cwd: dir });
    execSync('git config user.email "test@test.com"', { cwd: dir });
    execSync('git config user.name "Test"', { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns ISO timestamp for a commit", () => {
    const file = join(dir, "file.txt");
    writeFileSync(file, "hello\n");
    execSync("git add file.txt && git commit -m 'init'", { cwd: dir });
    const sha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();

    const ts = getCommitTimestamp(sha, dir);
    // Should be a valid ISO date
    assert.ok(!isNaN(new Date(ts).getTime()), `Expected valid date, got: ${ts}`);
  });
});

describe("commandExists", () => {
  it("returns true for git", () => {
    assert.equal(commandExists("git"), true);
  });

  it("returns false for nonexistent command", () => {
    assert.equal(commandExists("nonexistent-xyz-command"), false);
  });
});

describe("shortSha", () => {
  it("returns first 8 chars", () => {
    assert.equal(shortSha("abcdef1234567890"), "abcdef12");
  });
});

describe("findSnapshotInCommit", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "git-snapshot-test-"));
    execSync("git init", { cwd: dir });
    execSync('git config user.email "test@test.com"', { cwd: dir });
    execSync('git config user.name "Test"', { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns filename when .transcripts/ file in commit", () => {
    const file = join(dir, "code.ts");
    writeFileSync(file, "const x = 1;\n");
    execSync("git add code.ts && git commit -m 'init'", { cwd: dir });

    const snapshotDir = join(dir, ".transcripts");
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, "abcd1234-1234567890.jsonl"), "data\n");
    execSync("git add .transcripts && git commit --amend --no-edit", { cwd: dir });

    const sha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
    const result = findSnapshotInCommit(sha, dir);
    assert.equal(result, ".transcripts/abcd1234-1234567890.jsonl");
  });

  it("returns null when no .transcripts/ file in commit", () => {
    const file = join(dir, "code.ts");
    writeFileSync(file, "const x = 1;\n");
    execSync("git add code.ts && git commit -m 'init'", { cwd: dir });

    const sha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
    const result = findSnapshotInCommit(sha, dir);
    assert.equal(result, null);
  });
});
