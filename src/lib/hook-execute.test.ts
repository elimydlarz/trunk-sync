import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import type { HookInput, RepoState, HookPlan, SyncPlan } from "./hook-types.js";
import { gatherRepoState, findWorktreeForBranch, executePlan, executeSync } from "./hook-execute.js";

// ── Helpers ──────────────────────────────────────────────────────────

function initRepo(dir: string): void {
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
}

function makeInput(overrides: Partial<HookInput> = {}): HookInput {
  return {
    tool_name: "Write",
    tool_input: {},
    session_id: null,
    transcript_path: null,
    ...overrides,
  };
}

function makeState(dir: string, overrides: Partial<RepoState> = {}): RepoState {
  const gitDir = join(dir, ".git");
  return {
    repoRoot: dir,
    gitDir,
    relPath: null,
    insideRepo: true,
    gitignored: false,
    hasRemote: false,
    targetBranch: "main",
    currentBranch: "main",
    inMerge: false,
    hasStagedChanges: false,
    deletedFiles: [],
    ...overrides,
  };
}

function setupRepoWithRemote(prefix: string): {
  remote: string;
  clone: string;
  targetBranch: string;
} {
  const remote = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-remote-`)));
  execSync("git init --bare", { cwd: remote, stdio: "ignore" });

  const clone = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-clone-`)));
  execSync(`git clone "${remote}" .`, { cwd: clone, stdio: "ignore" });
  execSync('git config user.email "test@test.com"', { cwd: clone });
  execSync('git config user.name "Test"', { cwd: clone });

  // Initial commit
  writeFileSync(join(clone, "init.txt"), "init\n");
  execSync("git add init.txt && git commit -m init", { cwd: clone, stdio: "ignore" });
  execSync("git push origin main", { cwd: clone, stdio: "ignore" });

  return { remote, clone, targetBranch: "main" };
}

function jsonl(...objects: unknown[]): string {
  return objects.map((o) => JSON.stringify(o)).join("\n");
}

// ── gatherRepoState ──────────────────────────────────────────────────

describe("gatherRepoState", () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "hook-exec-test-")));
    initRepo(dir);
    writeFileSync(join(dir, "file.txt"), "hello\n");
    execSync("git add file.txt && git commit -m init", { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null outside a git repo", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "no-git-"));
    try {
      const origDir = process.cwd();
      process.chdir(tmpDir);
      const state = gatherRepoState(makeInput());
      process.chdir(origDir);
      assert.equal(state, null);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects repo root and git dir", () => {
    const origDir = process.cwd();
    process.chdir(dir);
    const state = gatherRepoState(
      makeInput({ tool_input: { file_path: join(dir, "file.txt") } }),
    );
    process.chdir(origDir);
    assert.ok(state);
    assert.equal(state.repoRoot, dir);
    assert.equal(state.insideRepo, true);
    assert.equal(state.relPath, "file.txt");
  });

  it("detects file outside repo", () => {
    const origDir = process.cwd();
    process.chdir(dir);
    const state = gatherRepoState(
      makeInput({ tool_input: { file_path: "/tmp/outside.txt" } }),
    );
    process.chdir(origDir);
    assert.ok(state);
    assert.equal(state.insideRepo, false);
  });

  it("detects gitignored files", () => {
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
    execSync("git add .gitignore && git commit -m 'add gitignore'", { cwd: dir });
    writeFileSync(join(dir, "ignored.txt"), "secret\n");
    const origDir = process.cwd();
    process.chdir(dir);
    const state = gatherRepoState(
      makeInput({ tool_input: { file_path: join(dir, "ignored.txt") } }),
    );
    process.chdir(origDir);
    assert.ok(state);
    assert.equal(state.gitignored, true);
  });

  it("detects no remote", () => {
    const origDir = process.cwd();
    process.chdir(dir);
    const state = gatherRepoState(makeInput());
    process.chdir(origDir);
    assert.ok(state);
    assert.equal(state.hasRemote, false);
  });

  it("detects deleted files", () => {
    rmSync(join(dir, "file.txt"));
    const origDir = process.cwd();
    process.chdir(dir);
    const state = gatherRepoState(makeInput());
    process.chdir(origDir);
    assert.ok(state);
    assert.deepEqual(state.deletedFiles, ["file.txt"]);
  });
});

// ── findWorktreeForBranch ────────────────────────────────────────────

describe("findWorktreeForBranch", () => {
  it("finds worktree for a branch", () => {
    const porcelain = [
      "worktree /home/user/project",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /home/user/project-wt",
      "HEAD def456",
      "branch refs/heads/feature",
    ].join("\n");
    assert.equal(findWorktreeForBranch(porcelain, "main"), "/home/user/project");
    assert.equal(findWorktreeForBranch(porcelain, "feature"), "/home/user/project-wt");
  });

  it("returns null for missing branch", () => {
    const porcelain = "worktree /path\nHEAD abc\nbranch refs/heads/main\n";
    assert.equal(findWorktreeForBranch(porcelain, "develop"), null);
  });
});

// ── executePlan ──────────────────────────────────────────────────────

describe("executePlan", () => {
  let dir: string;
  let origDir: string;
  let dirs: string[];

  beforeEach(() => {
    dirs = [];
    dir = realpathSync(mkdtempSync(join(tmpdir(), "exec-plan-")));
    dirs.push(dir);
    initRepo(dir);
    writeFileSync(join(dir, "seed.txt"), "seed\n");
    execSync("git add seed.txt && git commit -m seed", { cwd: dir, stdio: "ignore" });
    origDir = process.cwd();
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(origDir);
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function track(dir: string): string {
    dirs.push(dir);
    return dir;
  }

  it("skips on action=skip", () => {
    const plan: HookPlan = { action: "skip" };
    const input = makeInput();
    const state = makeState(dir);
    const commitsBefore = execSync("git rev-list --count HEAD", { cwd: dir, encoding: "utf-8" }).trim();
    const result = executePlan(plan, input, state);
    const commitsAfter = execSync("git rev-list --count HEAD", { cwd: dir, encoding: "utf-8" }).trim();
    assert.equal(result.exitCode, 0);
    assert.equal(commitsBefore, commitsAfter);
  });

  it("stages and commits a file", () => {
    const filePath = join(dir, "new.txt");
    writeFileSync(filePath, "new content\n");
    const plan: HookPlan = {
      action: "commit-and-sync",
      commit: {
        filesToStage: [filePath],
        filesToRemove: [],
        subject: "auto: write new.txt",
        body: null,
      },
      sync: null,
    };
    const input = makeInput({ tool_input: { file_path: filePath } });
    const state = makeState(dir);
    const result = executePlan(plan, input, state);
    assert.equal(result.exitCode, 0);
    const status = execSync("git status --porcelain", { cwd: dir, encoding: "utf-8" }).trim();
    assert.equal(status, "");
    const subject = execSync("git log -1 --format=%s", { cwd: dir, encoding: "utf-8" }).trim();
    assert.equal(subject, "auto: write new.txt");
  });

  it("includes body with session in commit", () => {
    const filePath = join(dir, "body.txt");
    writeFileSync(filePath, "body content\n");
    const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
    const plan: HookPlan = {
      action: "commit-and-sync",
      commit: {
        filesToStage: [filePath],
        filesToRemove: [],
        subject: "auto(abcdef12): write body.txt",
        body: `Session: ${sessionId}`,
      },
      sync: null,
    };
    const input = makeInput({ tool_input: { file_path: filePath }, session_id: sessionId });
    const state = makeState(dir);
    executePlan(plan, input, state);
    const body = execSync("git log -1 --format=%b", { cwd: dir, encoding: "utf-8" }).trim();
    assert.match(body, /Session: abcdef12/);
  });

  it("exits 0 when nothing staged", () => {
    // seed.txt is already committed and unchanged
    const filePath = join(dir, "seed.txt");
    const plan: HookPlan = {
      action: "commit-and-sync",
      commit: {
        filesToStage: [filePath],
        filesToRemove: [],
        subject: "auto: write seed.txt",
        body: null,
      },
      sync: null,
    };
    const input = makeInput({ tool_input: { file_path: filePath } });
    const state = makeState(dir);
    const commitsBefore = execSync("git rev-list --count HEAD", { cwd: dir, encoding: "utf-8" }).trim();
    const result = executePlan(plan, input, state);
    const commitsAfter = execSync("git rev-list --count HEAD", { cwd: dir, encoding: "utf-8" }).trim();
    assert.equal(result.exitCode, 0);
    assert.equal(commitsBefore, commitsAfter);
  });

  it("stages file deletions", () => {
    // Create and commit a file, then delete it from disk
    const filePath = join(dir, "to-delete.txt");
    writeFileSync(filePath, "delete me\n");
    execSync(`git add "${filePath}" && git commit -m "add to-delete"`, { cwd: dir, stdio: "ignore" });
    rmSync(filePath);

    const plan: HookPlan = {
      action: "commit-and-sync",
      commit: {
        filesToStage: [],
        filesToRemove: ["to-delete.txt"],
        subject: "auto: delete to-delete.txt",
        body: null,
      },
      sync: null,
    };
    const input = makeInput();
    const state = makeState(dir);
    const result = executePlan(plan, input, state);
    assert.equal(result.exitCode, 0);
    // Verify file is gone from git
    const files = execSync("git ls-files", { cwd: dir, encoding: "utf-8" }).trim();
    assert.ok(!files.includes("to-delete.txt"));
  });

  it("completes a merge (commit-merge)", () => {
    const { remote, clone } = setupRepoWithRemote("merge");
    track(remote);
    track(clone);
    process.chdir(clone);

    // Create a second clone that will push a conflicting change
    const clone2 = track(realpathSync(mkdtempSync(join(tmpdir(), "merge-clone2-"))));
    execSync(`git clone "${remote}" .`, { cwd: clone2, stdio: "ignore" });
    execSync('git config user.email "test@test.com"', { cwd: clone2 });
    execSync('git config user.name "Test"', { cwd: clone2 });
    writeFileSync(join(clone2, "conflict.txt"), "version A\n");
    execSync("git add conflict.txt && git commit -m 'add A' && git push origin main", {
      cwd: clone2,
      stdio: "ignore",
    });

    // In clone1, create a conflicting file
    writeFileSync(join(clone, "conflict.txt"), "version B\n");
    execSync("git add conflict.txt && git commit -m 'add B'", { cwd: clone, stdio: "ignore" });

    // Start merge that will conflict
    try {
      execSync("git pull origin main --no-rebase", { cwd: clone, stdio: "ignore" });
    } catch {
      // expected conflict
    }

    // Resolve the conflict manually
    writeFileSync(join(clone, "conflict.txt"), "resolved\n");

    const filePath = join(clone, "conflict.txt");
    const plan: HookPlan = {
      action: "commit-merge",
      message: "auto: resolve merge conflict in conflict.txt",
      sync: null,
    };
    const input = makeInput({ tool_input: { file_path: filePath } });
    const gitDir = execSync("git rev-parse --git-dir", { cwd: clone, encoding: "utf-8" }).trim();
    const state = makeState(clone, { gitDir, hasRemote: true, inMerge: true });

    const result = executePlan(plan, input, state);
    assert.equal(result.exitCode, 0);
    // MERGE_HEAD should be gone
    assert.ok(!existsSync(join(gitDir, "MERGE_HEAD")));
  });

  it("returns git exit code on unresolved merge", () => {
    const { remote, clone } = setupRepoWithRemote("unresolved");
    track(remote);
    track(clone);
    process.chdir(clone);

    const clone2 = track(realpathSync(mkdtempSync(join(tmpdir(), "unresolved-clone2-"))));
    execSync(`git clone "${remote}" .`, { cwd: clone2, stdio: "ignore" });
    execSync('git config user.email "test@test.com"', { cwd: clone2 });
    execSync('git config user.name "Test"', { cwd: clone2 });
    // Create two conflicting files
    writeFileSync(join(clone2, "conflict1.txt"), "version A\n");
    writeFileSync(join(clone2, "conflict2.txt"), "version A\n");
    execSync("git add . && git commit -m 'add A' && git push origin main", {
      cwd: clone2,
      stdio: "ignore",
    });

    writeFileSync(join(clone, "conflict1.txt"), "version B\n");
    writeFileSync(join(clone, "conflict2.txt"), "version B\n");
    execSync("git add . && git commit -m 'add B'", { cwd: clone, stdio: "ignore" });

    try {
      execSync("git pull origin main --no-rebase", { cwd: clone, stdio: "ignore" });
    } catch {
      // expected conflict
    }

    // Only pass one file — the other remains unresolved so git commit fails
    const plan: HookPlan = {
      action: "commit-merge",
      message: "auto: resolve merge conflict",
      sync: null,
    };
    const input = makeInput({ tool_input: { file_path: join(clone, "conflict1.txt") } });
    const gitDir = execSync("git rev-parse --git-dir", { cwd: clone, encoding: "utf-8" }).trim();
    const state = makeState(clone, { gitDir, hasRemote: true, inMerge: true });

    const result = executePlan(plan, input, state);
    assert.ok(result.exitCode !== 0);
  });

  it("enriches commit subject from transcript", () => {
    const filePath = join(dir, "enriched.txt");
    writeFileSync(filePath, "enriched\n");

    const transcriptPath = join(dir, "transcript.jsonl");
    writeFileSync(
      transcriptPath,
      jsonl({ type: "user", message: { role: "user", content: "Fix the login bug" } }),
    );

    const plan: HookPlan = {
      action: "commit-and-sync",
      commit: {
        filesToStage: [filePath],
        filesToRemove: [],
        subject: "auto: write enriched.txt",
        body: null,
      },
      sync: null,
    };
    const input = makeInput({
      tool_input: { file_path: filePath },
      transcript_path: transcriptPath,
      session_id: "abcdef12-3456-7890-abcd-ef1234567890",
    });
    const state = makeState(dir, { relPath: "enriched.txt" });

    executePlan(plan, input, state);
    const subject = execSync("git log -1 --format=%s", { cwd: dir, encoding: "utf-8" }).trim();
    assert.match(subject, /Fix the login bug/);
  });

  it("uses default subject when transcript unreadable", () => {
    const filePath = join(dir, "fallback.txt");
    writeFileSync(filePath, "fallback\n");

    const plan: HookPlan = {
      action: "commit-and-sync",
      commit: {
        filesToStage: [filePath],
        filesToRemove: [],
        subject: "auto: write fallback.txt",
        body: null,
      },
      sync: null,
    };
    const input = makeInput({
      tool_input: { file_path: filePath },
      transcript_path: "/nonexistent/transcript.jsonl",
    });
    const state = makeState(dir);

    const result = executePlan(plan, input, state);
    assert.equal(result.exitCode, 0);
    const subject = execSync("git log -1 --format=%s", { cwd: dir, encoding: "utf-8" }).trim();
    assert.equal(subject, "auto: write fallback.txt");
  });
});

// ── executeSync ──────────────────────────────────────────────────────

describe("executeSync", () => {
  let dirs: string[];
  let origDir: string;

  beforeEach(() => {
    dirs = [];
    origDir = process.cwd();
  });

  afterEach(() => {
    process.chdir(origDir);
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function track(dir: string): string {
    dirs.push(dir);
    return dir;
  }

  it("pulls and pushes to remote", () => {
    const { remote, clone } = setupRepoWithRemote("sync");
    track(remote);
    track(clone);

    process.chdir(clone);

    // Create a new commit in clone
    writeFileSync(join(clone, "new.txt"), "new\n");
    execSync("git add new.txt && git commit -m 'add new'", { cwd: clone, stdio: "ignore" });

    const sync: SyncPlan = { targetBranch: "main", currentBranch: "main" };
    const result = executeSync(sync);

    assert.equal(result.exitCode, 0);

    // Verify commit is on remote
    const remoteLog = execSync("git log --oneline", { cwd: remote, encoding: "utf-8" });
    assert.match(remoteLog, /add new/);
  });

  it("retries push after rejection", () => {
    const { remote, clone } = setupRepoWithRemote("retry");
    track(remote);
    track(clone);

    // Create clone2 that pushes first
    const clone2 = track(realpathSync(mkdtempSync(join(tmpdir(), "retry-clone2-"))));
    execSync(`git clone "${remote}" .`, { cwd: clone2, stdio: "ignore" });
    execSync('git config user.email "test@test.com"', { cwd: clone2 });
    execSync('git config user.name "Test"', { cwd: clone2 });
    writeFileSync(join(clone2, "a.txt"), "from clone2\n");
    execSync("git add a.txt && git commit -m 'clone2 commit' && git push origin main", {
      cwd: clone2,
      stdio: "ignore",
    });

    // clone1 has a different commit (different file, so no conflict on pull)
    process.chdir(clone);
    writeFileSync(join(clone, "b.txt"), "from clone1\n");
    execSync("git add b.txt && git commit -m 'clone1 commit'", { cwd: clone, stdio: "ignore" });

    const sync: SyncPlan = { targetBranch: "main", currentBranch: "main" };
    const result = executeSync(sync);

    assert.equal(result.exitCode, 0);

    // Both commits should be on remote
    const remoteLog = execSync("git log --oneline", { cwd: remote, encoding: "utf-8" });
    assert.match(remoteLog, /clone1 commit/);
    assert.match(remoteLog, /clone2 commit/);
  });

  it("returns exit 2 on merge conflict during pull", () => {
    const { remote, clone } = setupRepoWithRemote("conflict");
    track(remote);
    track(clone);

    // clone2 pushes a conflicting change
    const clone2 = track(realpathSync(mkdtempSync(join(tmpdir(), "conflict-clone2-"))));
    execSync(`git clone "${remote}" .`, { cwd: clone2, stdio: "ignore" });
    execSync('git config user.email "test@test.com"', { cwd: clone2 });
    execSync('git config user.name "Test"', { cwd: clone2 });
    writeFileSync(join(clone2, "shared.txt"), "version A\n");
    execSync("git add shared.txt && git commit -m 'A' && git push origin main", {
      cwd: clone2,
      stdio: "ignore",
    });

    // clone1 has a conflicting change on the same file
    process.chdir(clone);
    writeFileSync(join(clone, "shared.txt"), "version B\n");
    execSync("git add shared.txt && git commit -m 'B'", { cwd: clone, stdio: "ignore" });

    const sync: SyncPlan = { targetBranch: "main", currentBranch: "main" };
    const result = executeSync(sync);

    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr);
    assert.match(result.stderr, /TRUNK-SYNC CONFLICT/);
  });

  it("merges target branch on non-target worktree branch", () => {
    const { remote, clone } = setupRepoWithRemote("wt-merge");
    track(remote);
    track(clone);

    // Push a change from clone2 to main
    const clone2 = track(realpathSync(mkdtempSync(join(tmpdir(), "wt-clone2-"))));
    execSync(`git clone "${remote}" .`, { cwd: clone2, stdio: "ignore" });
    execSync('git config user.email "test@test.com"', { cwd: clone2 });
    execSync('git config user.name "Test"', { cwd: clone2 });
    writeFileSync(join(clone2, "from-main.txt"), "main change\n");
    execSync("git add from-main.txt && git commit -m 'main change' && git push origin main", {
      cwd: clone2,
      stdio: "ignore",
    });

    // clone1 is on a worktree branch
    process.chdir(clone);
    execSync("git checkout -b trunk-sync-wt", { cwd: clone, stdio: "ignore" });
    writeFileSync(join(clone, "wt-file.txt"), "worktree\n");
    execSync("git add wt-file.txt && git commit -m 'wt commit'", { cwd: clone, stdio: "ignore" });

    const sync: SyncPlan = { targetBranch: "main", currentBranch: "trunk-sync-wt" };
    const result = executeSync(sync);

    assert.equal(result.exitCode, 0);

    // Verify the main change was merged into worktree branch
    const log = execSync("git log --oneline", { cwd: clone, encoding: "utf-8" });
    assert.match(log, /main change/);
  });

  it("updates local target branch after push", () => {
    const { remote, clone } = setupRepoWithRemote("local-update");
    track(remote);
    track(clone);

    process.chdir(clone);

    writeFileSync(join(clone, "update.txt"), "update\n");
    execSync("git add update.txt && git commit -m 'update'", { cwd: clone, stdio: "ignore" });

    const sync: SyncPlan = { targetBranch: "main", currentBranch: "main" };
    executeSync(sync);

    // Local main ref should match origin/main
    const localRef = execSync("git rev-parse main", { cwd: clone, encoding: "utf-8" }).trim();
    const remoteRef = execSync("git rev-parse origin/main", { cwd: clone, encoding: "utf-8" }).trim();
    assert.equal(localRef, remoteRef);
  });
});

// ── amendWithTranscriptSnapshot (via executePlan) ────────────────────

describe("amendWithTranscriptSnapshot", () => {
  let dir: string;
  let origDir: string;
  let origHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "snapshot-")));
    initRepo(dir);
    writeFileSync(join(dir, "seed.txt"), "seed\n");
    execSync("git add seed.txt && git commit -m seed", { cwd: dir, stdio: "ignore" });
    origDir = process.cwd();
    process.chdir(dir);

    origHome = process.env.HOME;
    tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "home-")));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.chdir(origDir);
    if (origHome !== undefined) {
      process.env.HOME = origHome;
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("snapshots transcript when commit-transcripts=true", () => {
    // Write config
    writeFileSync(join(tmpHome, ".trunk-sync"), "commit-transcripts=true\n");

    // Create transcript file
    const transcriptPath = join(tmpHome, "session.jsonl");
    writeFileSync(transcriptPath, jsonl({ type: "user", message: { role: "user", content: "task" } }));

    const filePath = join(dir, "snap.txt");
    writeFileSync(filePath, "snap content\n");

    const plan: HookPlan = {
      action: "commit-and-sync",
      commit: {
        filesToStage: [filePath],
        filesToRemove: [],
        subject: "auto: write snap.txt",
        body: null,
      },
      sync: null,
    };
    const input = makeInput({
      tool_input: { file_path: filePath },
      transcript_path: transcriptPath,
      session_id: "abcdef12-3456-7890-abcd-ef1234567890",
    });
    const state = makeState(dir);

    executePlan(plan, input, state);

    // Check .transcripts/ exists in git tree
    const diffTree = execSync("git diff-tree --no-commit-id --name-only -r HEAD", {
      cwd: dir,
      encoding: "utf-8",
    });
    assert.match(diffTree, /\.transcripts\//);
  });

  it("skips snapshot when commit-transcripts=false", () => {
    // No config file → defaults to false

    const transcriptPath = join(tmpHome, "session.jsonl");
    writeFileSync(transcriptPath, jsonl({ type: "user", message: { role: "user", content: "task" } }));

    const filePath = join(dir, "no-snap.txt");
    writeFileSync(filePath, "content\n");

    const plan: HookPlan = {
      action: "commit-and-sync",
      commit: {
        filesToStage: [filePath],
        filesToRemove: [],
        subject: "auto: write no-snap.txt",
        body: null,
      },
      sync: null,
    };
    const input = makeInput({
      tool_input: { file_path: filePath },
      transcript_path: transcriptPath,
      session_id: "abcdef12-3456-7890-abcd-ef1234567890",
    });
    const state = makeState(dir);

    executePlan(plan, input, state);

    assert.ok(!existsSync(join(dir, ".transcripts")));
  });

  it("skips snapshot when no transcript_path", () => {
    writeFileSync(join(tmpHome, ".trunk-sync"), "commit-transcripts=true\n");

    const filePath = join(dir, "no-path.txt");
    writeFileSync(filePath, "content\n");

    const plan: HookPlan = {
      action: "commit-and-sync",
      commit: {
        filesToStage: [filePath],
        filesToRemove: [],
        subject: "auto: write no-path.txt",
        body: null,
      },
      sync: null,
    };
    const input = makeInput({ tool_input: { file_path: filePath } });
    const state = makeState(dir);

    executePlan(plan, input, state);

    assert.ok(!existsSync(join(dir, ".transcripts")));
  });

  it("continues on snapshot failure", () => {
    writeFileSync(join(tmpHome, ".trunk-sync"), "commit-transcripts=true\n");

    const filePath = join(dir, "fail-snap.txt");
    writeFileSync(filePath, "content\n");

    const plan: HookPlan = {
      action: "commit-and-sync",
      commit: {
        filesToStage: [filePath],
        filesToRemove: [],
        subject: "auto: write fail-snap.txt",
        body: null,
      },
      sync: null,
    };
    const input = makeInput({
      tool_input: { file_path: filePath },
      transcript_path: "/nonexistent/session.jsonl",
      session_id: "abcdef12-3456-7890-abcd-ef1234567890",
    });
    const state = makeState(dir);

    const result = executePlan(plan, input, state);
    assert.equal(result.exitCode, 0);

    // Commit still created
    const subject = execSync("git log -1 --format=%s", { cwd: dir, encoding: "utf-8" }).trim();
    assert.equal(subject, "auto: write fail-snap.txt");
  });
});
