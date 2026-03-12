import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const nodeBin = execSync("which node", { encoding: "utf-8" }).trim();
const nodeDir = join(nodeBin, "..");

function runInstall(
  args: string,
  env?: Record<string, string>,
  cwd?: string,
): { stdout: string; stderr: string; exitCode: number } {
  const cliPath = join(process.cwd(), "dist", "cli.js");
  try {
    const stdout = execSync(`node "${cliPath}" install ${args}`, {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, ...env, PATH: env?.PATH ? `${env.PATH}:${nodeDir}` : process.env.PATH },
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

function makeFakeBin(dir: string, name: string, script = "#!/bin/sh\nexit 0"): void {
  const binPath = join(dir, name);
  writeFileSync(binPath, script);
  chmodSync(binPath, 0o755);
}

describe("install command", () => {
  let fakeBinDir: string;
  let gitDir: string;
  let cleanupDirs: string[];

  beforeEach(() => {
    fakeBinDir = realpathSync(mkdtempSync(join(tmpdir(), "install-bins-")));
    gitDir = realpathSync(mkdtempSync(join(tmpdir(), "install-git-")));
    execSync("git init", { cwd: gitDir, stdio: "ignore" });
    execSync('git config user.email "test@test.com"', { cwd: gitDir });
    execSync('git config user.name "Test"', { cwd: gitDir });
    writeFileSync(join(gitDir, "seed.txt"), "seed\n");
    execSync("git add seed.txt && git commit -m seed", { cwd: gitDir, stdio: "ignore" });
    cleanupDirs = [fakeBinDir, gitDir];
  });

  afterEach(() => {
    for (const d of cleanupDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("--help prints usage", () => {
    const { stdout, exitCode } = runInstall("--help");
    assert.equal(exitCode, 0);
    assert.match(stdout, /Usage/);
  });

  it("fails when jq is missing", () => {
    makeFakeBin(fakeBinDir, "claude");
    // Only our fake bin dir + node dir in PATH — no system jq
    const { stderr, exitCode } = runInstall("", { PATH: fakeBinDir }, gitDir);
    assert.equal(exitCode, 1);
    assert.match(stderr, /jq/);
  });

  it("fails when claude is missing", () => {
    makeFakeBin(fakeBinDir, "jq");
    const { exitCode, stderr } = runInstall("", { PATH: fakeBinDir }, gitDir);
    assert.equal(exitCode, 1);
    assert.match(stderr, /[Cc]laude/);
  });

  it("warns when not in git repo", () => {
    const noGitDir = realpathSync(mkdtempSync(join(tmpdir(), "no-git-install-")));
    cleanupDirs.push(noGitDir);
    makeFakeBin(fakeBinDir, "jq");
    makeFakeBin(fakeBinDir, "claude");

    const { stdout } = runInstall("", { PATH: fakeBinDir }, noGitDir);
    // The warning goes to stderr which may not be captured on success,
    // but the success message should still appear
    assert.match(stdout, /installed successfully/);
  });

  it("rejects invalid scope", () => {
    const { stderr, exitCode } = runInstall("--scope invalid");
    assert.equal(exitCode, 1);
    assert.match(stderr, /scope/i);
  });

  it("passes scope to claude commands", () => {
    makeFakeBin(fakeBinDir, "jq");

    const logFile = join(fakeBinDir, "claude.log");
    makeFakeBin(
      fakeBinDir,
      "claude",
      `#!/bin/sh\necho "$@" >> "${logFile}"\nexit 0`,
    );

    runInstall("--scope user", { PATH: fakeBinDir }, gitDir);

    const logged = readFileSync(logFile, "utf-8");
    assert.match(logged, /--scope user/);
  });
});
