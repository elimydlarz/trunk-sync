import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, readFileSync, existsSync, realpathSync } from "node:fs";
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

  it("--inspect works when blamed line has shifted", () => {
    const file = join(dir, "code.ts");
    writeFileSync(file, "const original = 1;\n");
    gitIn(dir, "add code.ts");
    gitIn(dir, "commit -m 'auto(abcd1234): add code' -m 'Session: shift-test-session'");

    // Add lines above so original moves from line 1 to line 3
    writeFileSync(file, "const a = 0;\nconst b = 0;\nconst original = 1;\n");
    gitIn(dir, "add code.ts");
    gitIn(dir, "commit -m 'add lines above'");

    const output = runSeance(dir, `${file}:3 --inspect`);
    assert.match(output, /Session:\s+shift-test-session/);
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

  it("default mode without transcript exits with error", () => {
    const binDir = mkdtempSync(join(tmpdir(), "seance-bin-"));
    writeFileSync(
      join(binDir, "claude"),
      `#!/bin/sh\nexit 0\n`
    );
    chmodSync(join(binDir, "claude"), 0o755);

    const file = join(dir, "code.ts");
    writeFileSync(file, "const x = 1;\n");
    gitIn(dir, "add code.ts");
    gitIn(dir, "commit -m 'auto(abcd1234): add code' -m 'File: code.ts\nSession: aaaa-bbbb-cccc-dddd'");

    const output = runSeance(dir, `${file}:1`, binDir);
    assert.match(output, /has no transcript/);

    rmSync(binDir, { recursive: true, force: true });
  });

  it("default mode with .transcripts/ snapshot uses snapshot for rewind", () => {
    const binDir = mkdtempSync(join(tmpdir(), "seance-bin-"));
    const logFile = join(binDir, "claude.log");
    const captureFile = join(binDir, "captured-transcript.jsonl");
    writeFileSync(
      join(binDir, "claude"),
      `#!/bin/sh
echo "cwd=$(pwd)" > "${logFile}"
echo "args=$*" >> "${logFile}"
RESUME_ID=$(echo "$*" | sed 's/.*--resume \\([^ ]*\\).*/\\1/')
WORKTREE_CWD=$(pwd)
SLUG=$(echo "$WORKTREE_CWD" | sed 's|[/.]|-|g')
REWOUND_FILE="$HOME/.claude/projects/$SLUG/$RESUME_ID.jsonl"
if [ -f "$REWOUND_FILE" ]; then
  cp "$REWOUND_FILE" "${captureFile}"
fi
exit 0
`
    );
    chmodSync(join(binDir, "claude"), 0o755);

    // Create a transcript snapshot as part of the commit (simulating hook behavior)
    const originalSessionId = "snap-bbbb-cccc-dddd";
    const transcriptLines = [
      JSON.stringify({ type: "file-history-snapshot", timestamp: "2026-03-01T09:59:59.000Z", sessionId: originalSessionId, cwd: "/original/project" }),
      JSON.stringify({ type: "user", timestamp: "2026-03-01T10:00:00.000Z", sessionId: originalSessionId, cwd: "/original/project", message: { role: "user", content: "snapshot task" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-03-01T10:00:01.000Z", sessionId: originalSessionId, cwd: "/original/project", message: { role: "assistant", content: [{ type: "text", text: "working" }] } }),
    ];

    const file = join(dir, "code.ts");
    writeFileSync(file, "const x = 1;\n");
    gitIn(dir, "add code.ts");

    // Commit with code, then amend to include snapshot (like the hook does)
    const commitDate = "2026-03-01T10:00:01.500Z";
    execSync(
      `git commit -m 'auto(snap1234): add code' -m 'File: code.ts\nSession: ${originalSessionId}'`,
      { cwd: dir, env: { ...process.env, GIT_COMMITTER_DATE: commitDate } }
    );

    // Add snapshot to .transcripts/ and amend
    const snapshotDir = join(dir, ".transcripts");
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, "snap1234-1234567890.jsonl"), transcriptLines.join("\n") + "\n");
    execSync("git add .transcripts && git commit --amend --no-edit", {
      cwd: dir,
      env: { ...process.env, GIT_COMMITTER_DATE: commitDate },
    });

    const output = runSeance(dir, `${file}:1`, binDir);

    // Should rewind using the snapshot (no Transcript: field needed)
    assert.match(output, /Rewound session to commit/);
    assert.match(output, new RegExp(`Forking session ${originalSessionId}`));

    // Verify the rewound transcript was created from snapshot
    assert.ok(existsSync(captureFile), "mock claude should have captured the rewound transcript");
    const capturedLines = readFileSync(captureFile, "utf-8").split("\n").filter(Boolean);
    assert.equal(capturedLines.length, 3, "should have all 3 lines (timestamps <= commit time)");

    rmSync(binDir, { recursive: true, force: true });
  });

  it("prompt uses original line number from blamed commit, not current line", () => {
    const binDir = mkdtempSync(join(tmpdir(), "seance-bin-"));
    const logFile = join(binDir, "claude.log");
    writeFileSync(
      join(binDir, "claude"),
      `#!/bin/sh
echo "args=$*" > "${logFile}"
exit 0
`
    );
    chmodSync(join(binDir, "claude"), 0o755);

    const originalSessionId = "orig-line-test-session";
    const realDir = realpathSync(dir);
    const repoSlug = realDir.replace(/[/.]/g, "-");
    const transcriptDir = join(process.env.HOME || "", ".claude", "projects", repoSlug);
    mkdirSync(transcriptDir, { recursive: true });
    const transcriptFile = join(transcriptDir, `${originalSessionId}.jsonl`);

    // Commit 1: 'target line' is at line 1
    const file = join(dir, "code.ts");
    const commitDate = "2026-03-01T10:00:01.000Z";
    writeFileSync(file, "const target = true;\n");
    gitIn(dir, "add code.ts");
    execSync(
      `git commit -m 'auto(abcd1234): add code' -m 'Session: ${originalSessionId}'`,
      { cwd: dir, env: { ...process.env, GIT_COMMITTER_DATE: commitDate } }
    );

    // Commit 2: add lines above, pushing 'target' from line 1 → line 4
    writeFileSync(file, "import a from 'a';\nimport b from 'b';\nimport c from 'c';\nconst target = true;\n");
    gitIn(dir, "add code.ts");
    gitIn(dir, "commit -m 'add imports'");

    // Write a transcript that covers the first commit's timestamp
    const transcriptLines = [
      JSON.stringify({ type: "user", timestamp: "2026-03-01T10:00:00.000Z", sessionId: originalSessionId, cwd: dir, message: { role: "user", content: "task" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-03-01T10:00:01.000Z", sessionId: originalSessionId, cwd: dir, message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
    ];
    writeFileSync(transcriptFile, transcriptLines.join("\n") + "\n");

    // Seance line 4 in current file — should blame back to commit 1 where it was line 1
    const output = runSeance(dir, `${file}:4`, binDir);
    assert.match(output, /Rewound session to commit/);

    // The prompt passed to claude should reference line 1, not line 4
    const log = readFileSync(logFile, "utf-8");
    assert.match(log, /code\.ts:1/, "prompt should reference original line 1, not current line 4");
    assert.ok(!log.includes("code.ts:4"), "prompt should NOT reference current line 4");

    rmSync(binDir, { recursive: true, force: true });
    rmSync(transcriptDir, { recursive: true, force: true });
  });

  it("default mode with transcript rewinds session to commit point", () => {
    const binDir = mkdtempSync(join(tmpdir(), "seance-bin-"));
    const logFile = join(binDir, "claude.log");
    // Mock claude binary that captures the rewound transcript before exiting
    const captureFile = join(binDir, "captured-transcript.jsonl");
    writeFileSync(
      join(binDir, "claude"),
      `#!/bin/sh
echo "cwd=$(pwd)" > "${logFile}"
echo "args=$*" >> "${logFile}"
# Capture the rewound transcript content so we can verify it
RESUME_ID=$(echo "$*" | sed 's/.*--resume \\([^ ]*\\).*/\\1/')
# Find the rewound file by looking in the project dir for the worktree
WORKTREE_CWD=$(pwd)
SLUG=$(echo "$WORKTREE_CWD" | sed 's|[/.]|-|g')
REWOUND_FILE="$HOME/.claude/projects/$SLUG/$RESUME_ID.jsonl"
if [ -f "$REWOUND_FILE" ]; then
  cp "$REWOUND_FILE" "${captureFile}"
fi
exit 0
`
    );
    chmodSync(join(binDir, "claude"), 0o755);

    // Create a fake transcript at the derived path seance will look for
    const originalSessionId = "aaaa-bbbb-cccc-dddd";
    const realDir = realpathSync(dir);
    const repoSlug = realDir.replace(/[/.]/g, "-");
    const transcriptDir = join(process.env.HOME || "", ".claude", "projects", repoSlug);
    mkdirSync(transcriptDir, { recursive: true });
    const transcriptFile = join(transcriptDir, `${originalSessionId}.jsonl`);
    const transcriptLines = [
      JSON.stringify({ type: "file-history-snapshot", timestamp: "2026-03-01T09:59:59.000Z", sessionId: originalSessionId, cwd: "/original/project" }),
      JSON.stringify({ type: "user", timestamp: "2026-03-01T10:00:00.000Z", sessionId: originalSessionId, cwd: "/original/project", message: { role: "user", content: "first task" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-03-01T10:00:01.000Z", sessionId: originalSessionId, cwd: "/original/project", message: { role: "assistant", content: [{ type: "text", text: "working on it" }] } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-03-01T10:00:02.000Z", sessionId: originalSessionId, cwd: "/original/project", message: { role: "assistant", content: [{ type: "tool_use" }] } }),
      JSON.stringify({ type: "user", timestamp: "2026-03-01T10:00:03.000Z", sessionId: originalSessionId, cwd: "/original/project", message: { role: "user", content: "second task" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-03-01T10:00:04.000Z", sessionId: originalSessionId, cwd: "/original/project", message: { role: "assistant", content: [{ type: "text", text: "later work" }] } }),
    ];
    writeFileSync(transcriptFile, transcriptLines.join("\n") + "\n");

    const file = join(dir, "code.ts");
    writeFileSync(file, "const x = 1;\n");
    gitIn(dir, "add code.ts");

    // Use GIT_COMMITTER_DATE to set the commit timestamp to 10:00:02.500
    // (between lines 3 and 4 of the transcript)
    const commitDate = "2026-03-01T10:00:02.500Z";
    execSync(
      `git commit -m 'auto(abcd1234): add code' -m 'File: code.ts\nSession: ${originalSessionId}'`,
      { cwd: dir, env: { ...process.env, GIT_COMMITTER_DATE: commitDate } }
    );
    const commitSha = gitIn(dir, "rev-parse HEAD");
    const short = commitSha.slice(0, 8);

    const output = runSeance(dir, `${file}:1`, binDir);

    // Verify rewind happened
    assert.match(output, /Rewound session to commit/);
    assert.match(output, /Forking session aaaa-bbbb-cccc-dddd/);

    // Verify claude was called with a NEW session ID (not the original)
    const log = readFileSync(logFile, "utf-8");
    assert.ok(!log.includes(`--resume ${originalSessionId}`), "should resume from rewound session, not original");
    assert.match(log, /--resume/);

    // Extract the new session ID from the claude args
    const resumeMatch = log.match(/--resume ([^\s]+)/);
    assert.ok(resumeMatch, "should have --resume arg");
    const newSessionId = resumeMatch![1];
    assert.notEqual(newSessionId, originalSessionId, "new session ID should differ from original");

    // Verify the rewound transcript has correct content
    assert.ok(existsSync(captureFile), "mock claude should have captured the rewound transcript");
    const capturedLines = readFileSync(captureFile, "utf-8").split("\n").filter(Boolean);
    assert.equal(capturedLines.length, 4, "should have 4 lines (timestamps <= 10:00:02.500)");

    // Verify sessionId and cwd were rewritten in the rewound transcript
    // Use realpathSync because git rev-parse --show-toplevel resolves symlinks (e.g. /var → /private/var on macOS)
    const worktreePath = join(realpathSync(dir), ".claude", "worktrees", `seance-${short}`);
    for (const line of capturedLines) {
      const obj = JSON.parse(line);
      if (obj.sessionId) {
        assert.equal(obj.sessionId, newSessionId, "sessionId should be rewritten to new ID");
      }
      if (obj.cwd) {
        assert.equal(obj.cwd, worktreePath, "cwd should be rewritten to worktree path");
      }
    }

    // Verify worktree was cleaned up
    const worktrees = gitIn(dir, "worktree list");
    assert.ok(!worktrees.includes(`seance-${short}`), "worktree should be removed after claude exits");

    // Verify rewound transcript was cleaned up (it's in the project dir, not transcriptDir)
    const slug = worktreePath.replace(/[/.]/g, "-");
    const projectDir = join(process.env.HOME || "", ".claude", "projects", slug);
    const rewoundFile = join(projectDir, `${newSessionId}.jsonl`);
    assert.ok(!existsSync(rewoundFile), "rewound transcript should be cleaned up after claude exits");

    // Original transcript should be untouched
    const originalLines = readFileSync(transcriptFile, "utf-8").split("\n").filter(Boolean);
    assert.equal(originalLines.length, 6, "original transcript should be untouched");

    rmSync(binDir, { recursive: true, force: true });
    rmSync(transcriptDir, { recursive: true, force: true });
    // Clean up project dir if empty
    try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

});
