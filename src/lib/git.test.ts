import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  parseFileRef,
  extractSessionId,
  extractTranscriptPath,
  blame,
  getCommitBody,
  getCommitTimestamp,
  commandExists,
  shortSha,
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
    const body = "File: src/main.ts\nSession: abc-123-def\nTranscript: /path";
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

    const sha = blame(file, 1, dir);
    assert.match(sha, /^[0-9a-f]{40}$/);

    const body = getCommitBody(sha, dir);
    assert.equal(extractSessionId(body), "test-session-id");
  });

  it("returns zeros for uncommitted lines", () => {
    const file = join(dir, "first.txt");
    writeFileSync(file, "committed\n");
    execSync("git add first.txt && git commit -m 'init'", { cwd: dir });

    writeFileSync(file, "committed\nuncommitted\n");
    const sha = blame(file, 2, dir);
    assert.match(sha, /^0+$/);
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
