import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

function runConfig(args: string, env?: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  const cliPath = join(process.cwd(), "dist", "cli.js");
  try {
    const stdout = execSync(`node "${cliPath}" config ${args}`, {
      encoding: "utf-8",
      env: { ...process.env, ...env },
    }).trim();
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string; status?: number };
    return {
      stdout: (err.stdout || "").trim(),
      stderr: (err.stderr || "").trim(),
      exitCode: err.status ?? 1,
    };
  }
}

describe("config command", () => {
  let configFile: string;
  let origHome: string | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    const tmpHome = mkdtempSync(join(tmpdir(), "config-test-"));
    process.env.HOME = tmpHome;
    configFile = join(tmpHome, ".trunk-sync");
  });

  afterEach(() => {
    if (origHome !== undefined) {
      process.env.HOME = origHome;
    }
    try { rmSync(configFile); } catch { /* ok */ }
  });

  it("show empty config when no file exists", () => {
    const { stdout } = runConfig("", { HOME: process.env.HOME! });
    assert.match(stdout, /No config set/);
  });

  it("set a value", () => {
    runConfig("commit-transcripts=true", { HOME: process.env.HOME! });
    const content = readFileSync(configFile, "utf-8");
    assert.match(content, /commit-transcripts=true/);
  });

  it("show config after setting values", () => {
    writeFileSync(configFile, "commit-transcripts=true\nother=value\n");
    const { stdout } = runConfig("", { HOME: process.env.HOME! });
    assert.match(stdout, /commit-transcripts=true/);
    assert.match(stdout, /other=value/);
  });

  it("get a single value", () => {
    writeFileSync(configFile, "commit-transcripts=true\nother=value\n");
    const { stdout, exitCode } = runConfig("commit-transcripts", { HOME: process.env.HOME! });
    assert.equal(exitCode, 0);
    assert.equal(stdout, "true");
  });

  it("get key with default when not set", () => {
    const { stdout, exitCode } = runConfig("commit-transcripts", { HOME: process.env.HOME! });
    assert.equal(exitCode, 0);
    assert.equal(stdout, "false");
  });

  it("get unknown key errors", () => {
    const { stderr, exitCode } = runConfig("nonexistent", { HOME: process.env.HOME! });
    assert.equal(exitCode, 1);
    assert.match(stderr, /Unknown key/);
  });

  it("unset a value", () => {
    writeFileSync(configFile, "commit-transcripts=true\nother=value\n");
    runConfig("--unset commit-transcripts", { HOME: process.env.HOME! });
    const content = readFileSync(configFile, "utf-8");
    assert.ok(!content.includes("commit-transcripts"));
    assert.match(content, /other=value/);
  });

  it("unset nonexistent key errors", () => {
    const { stderr, exitCode } = runConfig("--unset nonexistent", { HOME: process.env.HOME! });
    assert.equal(exitCode, 1);
    assert.match(stderr, /Key not found/);
  });

  it("handles comments and blank lines in config file", () => {
    writeFileSync(configFile, "# comment\n\ncommit-transcripts=true\n");
    const { stdout } = runConfig("", { HOME: process.env.HOME! });
    assert.match(stdout, /commit-transcripts=true/);
    assert.ok(!stdout.includes("#"));
  });
});
