import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

function gitIn(dir: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: dir, encoding: "utf-8" }).trim();
}

function runSeance(dir: string, args: string): string {
  const cliPath = join(process.cwd(), "dist", "cli.js");
  try {
    return execSync(`node "${cliPath}" seance ${args}`, {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, PATH: process.env.PATH },
    }).trim();
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string };
    return (err.stderr || err.stdout || "").trim();
  }
}

describe("seance integration", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seance-test-"));
    execSync("git init", { cwd: dir });
    gitIn(dir, 'config user.email "test@test.com"');
    gitIn(dir, 'config user.name "Test"');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("--inspect shows session info for trunk-sync commit", () => {
    const file = join(dir, "code.ts");
    writeFileSync(file, "const x = 1;\n");
    gitIn(dir, "add code.ts");
    gitIn(dir, "commit -m 'auto(abcd1234): add code' -m 'File: code.ts\nSession: aaaa-bbbb-cccc-dddd'");

    const output = runSeance(dir, `${file}:1 --inspect`);
    assert.match(output, /Session:\s+aaaa-bbbb-cccc-dddd/);
    assert.match(output, /Subject:\s+auto\(abcd1234\): add code/);
  });

  it("errors on uncommitted line", () => {
    const file = join(dir, "code.ts");
    writeFileSync(file, "committed\n");
    gitIn(dir, "add code.ts");
    gitIn(dir, "commit -m 'init'");
    writeFileSync(file, "committed\nuncommitted\n");

    const output = runSeance(dir, `${file}:2 --inspect`);
    assert.match(output, /uncommitted changes/);
  });

  it("errors on non-trunk-sync commit", () => {
    const file = join(dir, "code.ts");
    writeFileSync(file, "const x = 1;\n");
    gitIn(dir, "add code.ts");
    gitIn(dir, "commit -m 'normal commit'");

    const output = runSeance(dir, `${file}:1 --inspect`);
    assert.match(output, /not created by trunk-sync/);
  });

  it("--list shows sessions", () => {
    const file = join(dir, "code.ts");
    writeFileSync(file, "v1\n");
    gitIn(dir, "add code.ts");
    gitIn(dir, "commit -m 'auto(abcd1234): first' -m 'Session: sess-1111'");

    writeFileSync(file, "v2\n");
    gitIn(dir, "add code.ts");
    gitIn(dir, "commit -m 'auto(efgh5678): second' -m 'Session: sess-2222'");

    const output = runSeance(dir, "--list");
    assert.match(output, /sess-2222/);
    assert.match(output, /sess-1111/);
  });

  it("--list shows nothing for non-trunk-sync repos", () => {
    const file = join(dir, "code.ts");
    writeFileSync(file, "v1\n");
    gitIn(dir, "add code.ts");
    gitIn(dir, "commit -m 'normal commit'");

    const output = runSeance(dir, "--list");
    assert.match(output, /No trunk-sync sessions/);
  });
});
