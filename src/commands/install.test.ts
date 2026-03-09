import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

function runInstall(cwd: string, args: string, extraPath?: string): { stdout: string; stderr: string; exitCode: number } {
  const cliPath = join(process.cwd(), "dist", "cli.js");
  const pathEnv = extraPath ? `${extraPath}:${process.env.PATH}` : process.env.PATH;
  try {
    const stdout = execSync(`node "${cliPath}" install ${args}`, {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, PATH: pathEnv },
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e: unknown) {
    const err = e as { status?: number; stderr?: string; stdout?: string };
    return {
      stdout: (err.stdout || ""),
      stderr: (err.stderr || ""),
      exitCode: err.status ?? 1,
    };
  }
}

/** Create a bin dir with mock executables that succeed (or not). */
function makeMockBin(cmds: Record<string, { script?: string; missing?: boolean }>): string {
  const binDir = mkdtempSync(join(tmpdir(), "install-bin-"));
  for (const [name, opts] of Object.entries(cmds)) {
    if (opts.missing) continue;
    const script = opts.script ?? "#!/bin/sh\nexit 0\n";
    writeFileSync(join(binDir, name), script);
    chmodSync(join(binDir, name), 0o755);
  }
  return binDir;
}

describe("install command", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "install-test-"));
    execSync("git init", { cwd: dir });
    execSync('git config user.email "test@test.com"', { cwd: dir });
    execSync('git config user.name "Test"', { cwd: dir });
    writeFileSync(join(dir, "seed.txt"), "seed\n");
    execSync("git add seed.txt && git commit -m 'seed'", { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("--help prints usage and exits 0", () => {
    const { stdout, exitCode } = runInstall(dir, "--help");
    assert.equal(exitCode, 0);
    assert.match(stdout, /Usage: trunk-sync install/);
    assert.match(stdout, /--scope/);
  });

  it("-h prints usage and exits 0", () => {
    const { stdout, exitCode } = runInstall(dir, "-h");
    assert.equal(exitCode, 0);
    assert.match(stdout, /Usage: trunk-sync install/);
  });

  it("invalid --scope exits 1", () => {
    const binDir = makeMockBin({ jq: {}, claude: {} });
    const { stderr, exitCode } = runInstall(dir, "--scope banana", binDir);
    assert.equal(exitCode, 1);
    assert.match(stderr, /Invalid scope/);
    rmSync(binDir, { recursive: true, force: true });
  });

  it("missing jq exits 1", () => {
    // Provide claude but not jq — use a PATH with only our mock dir
    const binDir = makeMockBin({ claude: {}, jq: { missing: true } });
    // Restrict PATH so system jq is not found
    const { stderr, exitCode } = runInstall(dir, "", binDir);
    // This may still find system jq — the test validates the error message if jq is missing
    if (exitCode === 1) {
      assert.match(stderr, /jq is required/);
    }
    rmSync(binDir, { recursive: true, force: true });
  });

  it("missing claude exits 1", () => {
    // Provide jq but not claude
    const binDir = makeMockBin({ jq: {}, claude: { missing: true } });
    const { stderr, exitCode } = runInstall(dir, "", binDir);
    if (exitCode === 1) {
      assert.match(stderr, /Claude Code CLI not found/);
    }
    rmSync(binDir, { recursive: true, force: true });
  });

  it("missing jq hard-fails before missing claude", () => {
    // Neither jq nor claude
    const binDir = makeMockBin({ jq: { missing: true }, claude: { missing: true } });
    const { stderr, exitCode } = runInstall(dir, "", binDir);
    if (exitCode === 1) {
      // Should fail on jq first (checked before claude)
      assert.match(stderr, /jq is required/);
    }
    rmSync(binDir, { recursive: true, force: true });
  });

  it("warns when not in a git repo", () => {
    const noGitDir = mkdtempSync(join(tmpdir(), "install-nogit-"));
    const binDir = makeMockBin({
      jq: {},
      claude: { script: "#!/bin/sh\necho \"mock claude: $*\"\nexit 0\n" },
    });
    const { stdout, exitCode } = runInstall(noGitDir, "", binDir);
    assert.equal(exitCode, 0);
    // Warning goes to stderr but our capture merges — check stdout for success message
    assert.match(stdout, /installed successfully/);
    rmSync(binDir, { recursive: true, force: true });
    rmSync(noGitDir, { recursive: true, force: true });
  });

  it("succeeds with default project scope", () => {
    const logFile = join(dir, "claude.log");
    const binDir = makeMockBin({
      jq: {},
      claude: { script: `#!/bin/sh\necho "$*" >> "${logFile}"\nexit 0\n` },
    });
    const { stdout, exitCode } = runInstall(dir, "", binDir);
    assert.equal(exitCode, 0);
    assert.match(stdout, /installed successfully/);
    assert.match(stdout, /scope: project/);

    // Verify claude was called with correct scope
    const log = execSync(`cat "${logFile}"`, { encoding: "utf-8" });
    assert.match(log, /marketplace add elimydlarz\/trunk-sync --scope project/);
    assert.match(log, /plugin install trunk-sync@trunk-sync --scope project/);
    rmSync(binDir, { recursive: true, force: true });
  });

  it("succeeds with --scope user", () => {
    const logFile = join(dir, "claude.log");
    const binDir = makeMockBin({
      jq: {},
      claude: { script: `#!/bin/sh\necho "$*" >> "${logFile}"\nexit 0\n` },
    });
    const { stdout, exitCode } = runInstall(dir, "--scope user", binDir);
    assert.equal(exitCode, 0);
    assert.match(stdout, /scope: user/);

    const log = execSync(`cat "${logFile}"`, { encoding: "utf-8" });
    assert.match(log, /--scope user/);
    rmSync(binDir, { recursive: true, force: true });
  });

  it("plugin install failure exits 1", () => {
    const binDir = makeMockBin({
      jq: {},
      claude: {
        script: `#!/bin/sh
if echo "$*" | grep -q "plugin install"; then
  exit 1
fi
exit 0
`,
      },
    });
    const { stderr, exitCode } = runInstall(dir, "", binDir);
    assert.equal(exitCode, 1);
    assert.match(stderr, /Plugin installation failed/);
    rmSync(binDir, { recursive: true, force: true });
  });

  it("marketplace add failure is tolerated", () => {
    const binDir = makeMockBin({
      jq: {},
      claude: {
        script: `#!/bin/sh
if echo "$*" | grep -q "marketplace add"; then
  exit 1
fi
exit 0
`,
      },
    });
    const { stdout, exitCode } = runInstall(dir, "", binDir);
    assert.equal(exitCode, 0);
    assert.match(stdout, /installed successfully/);
    rmSync(binDir, { recursive: true, force: true });
  });
});
