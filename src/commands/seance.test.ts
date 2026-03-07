import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

function gitIn(dir: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: dir, encoding: "utf-8" }).trim();
}

function runSeance(dir: string, args: string, extraPath?: string): string {
  const cliPath = join(process.cwd(), "dist", "cli.js");
  const pathEnv = extraPath ? `${extraPath}:${process.env.PATH}` : process.env.PATH;
  try {
    return execSync(`node "${cliPath}" seance ${args}`, {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, PATH: pathEnv },
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

  it("default mode creates worktree at blamed commit and passes prompt", () => {
    // Create a fake claude binary that records its args and cwd
    const binDir = mkdtempSync(join(tmpdir(), "seance-bin-"));
    const logFile = join(binDir, "claude.log");
    writeFileSync(
      join(binDir, "claude"),
      `#!/bin/sh\necho "cwd=$(pwd)" > "${logFile}"\necho "args=$*" >> "${logFile}"\nexit 0\n`
    );
    chmodSync(join(binDir, "claude"), 0o755);

    const file = join(dir, "code.ts");
    writeFileSync(file, "const x = 1;\n");
    gitIn(dir, "add code.ts");
    gitIn(dir, "commit -m 'auto(abcd1234): add code' -m 'File: code.ts\nSession: aaaa-bbbb-cccc-dddd'");
    const commitSha = gitIn(dir, "rev-parse HEAD");
    const short = commitSha.slice(0, 8);

    const output = runSeance(dir, `${file}:1`, binDir);

    // Verify output mentions worktree and forking
    assert.match(output, /Forking session aaaa-bbbb-cccc-dddd/);
    assert.match(output, /Worktree at/);

    // Verify claude was called with the right args and cwd
    const log = readFileSync(logFile, "utf-8");
    assert.match(log, /--resume aaaa-bbbb-cccc-dddd --fork-session/);
    assert.match(log, /Explain yourself!/);
    assert.match(log, new RegExp(`cwd=.*seance-${short}`));

    // Verify worktree was cleaned up
    const worktrees = gitIn(dir, "worktree list");
    assert.ok(!worktrees.includes(`seance-${short}`), "worktree should be removed after claude exits");

    // Cleanup fake bin dir
    rmSync(binDir, { recursive: true, force: true });
  });
});
