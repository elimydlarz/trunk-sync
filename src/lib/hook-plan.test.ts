import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HookInput, RepoState } from "./hook-types.js";
import {
  parseHookInput,
  planHook,
  buildCommitPlanWithTask,
  buildSessionPrefix,
  buildCommitBody,
  extractTaskFromTranscript,
  summarizeDeletions,
} from "./hook-plan.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeInput(overrides: Partial<HookInput> = {}): HookInput {
  return {
    tool_name: "Write",
    tool_input: { file_path: "/repo/src/main.ts" },
    session_id: "abcdef12-3456-7890-abcd-ef1234567890",
    transcript_path: "~/.claude/projects/proj/session.jsonl",
    ...overrides,
  };
}

function makeState(overrides: Partial<RepoState> = {}): RepoState {
  return {
    repoRoot: "/repo",
    gitDir: "/repo/.git",
    relPath: "src/main.ts",
    insideRepo: true,
    gitignored: false,
    hasRemote: true,
    targetBranch: "main",
    currentBranch: "main",
    inMerge: false,
    hasStagedChanges: false,
    deletedFiles: [],
    ...overrides,
  };
}

// ── parseHookInput ───────────────────────────────────────────────────

describe("parseHookInput", () => {
  it("parses complete input", () => {
    const json = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "/repo/file.ts" },
      session_id: "abc-123",
      transcript_path: "/path/to/transcript",
    });
    const result = parseHookInput(json);
    assert.equal(result.tool_name, "Edit");
    assert.equal(result.tool_input.file_path, "/repo/file.ts");
    assert.equal(result.session_id, "abc-123");
    assert.equal(result.transcript_path, "/path/to/transcript");
  });

  it("defaults missing fields to null", () => {
    const result = parseHookInput("{}");
    assert.equal(result.tool_name, null);
    assert.deepEqual(result.tool_input, {});
    assert.equal(result.session_id, null);
    assert.equal(result.transcript_path, null);
  });

  it("throws on invalid JSON", () => {
    assert.throws(() => parseHookInput("not json"));
  });
});

// ── planHook: skip conditions ────────────────────────────────────────

describe("planHook skip conditions", () => {
  it("skips when no file_path and no deletions", () => {
    const input = makeInput({ tool_input: {} });
    const state = makeState({ deletedFiles: [] });
    const plan = planHook(input, state);
    assert.equal(plan.action, "skip");
  });

  it("skips when file is outside the repo", () => {
    const input = makeInput({ tool_input: { file_path: "/other/file.ts" } });
    const state = makeState({ insideRepo: false });
    const plan = planHook(input, state);
    assert.equal(plan.action, "skip");
  });

  it("skips when file is gitignored", () => {
    const input = makeInput();
    const state = makeState({ gitignored: true });
    const plan = planHook(input, state);
    assert.equal(plan.action, "skip");
  });
});

// ── planHook: merge state ────────────────────────────────────────────

describe("planHook merge state", () => {
  it("produces commit-merge with session prefix", () => {
    const input = makeInput();
    const state = makeState({ inMerge: true });
    const plan = planHook(input, state);
    assert.equal(plan.action, "commit-merge");
    if (plan.action !== "commit-merge") return;
    assert.equal(plan.message, "auto(abcdef12): resolve merge conflict in src/main.ts");
  });

  it("produces commit-merge without session prefix", () => {
    const input = makeInput({ session_id: null });
    const state = makeState({ inMerge: true });
    const plan = planHook(input, state);
    if (plan.action !== "commit-merge") return;
    assert.equal(plan.message, "auto: resolve merge conflict in src/main.ts");
  });

  it("includes sync plan when remote exists", () => {
    const input = makeInput();
    const state = makeState({ inMerge: true, hasRemote: true });
    const plan = planHook(input, state);
    if (plan.action !== "commit-merge") return;
    assert.deepEqual(plan.sync, { targetBranch: "main", currentBranch: "main" });
  });

  it("sync is null when no remote", () => {
    const input = makeInput();
    const state = makeState({ inMerge: true, hasRemote: false });
    const plan = planHook(input, state);
    if (plan.action !== "commit-merge") return;
    assert.equal(plan.sync, null);
  });
});

// ── planHook: normal commit ──────────────────────────────────────────

describe("planHook normal commit", () => {
  it("produces commit-and-sync for a file edit", () => {
    const input = makeInput();
    const state = makeState();
    const plan = planHook(input, state);
    assert.equal(plan.action, "commit-and-sync");
    if (plan.action !== "commit-and-sync") return;
    assert.deepEqual(plan.commit.filesToStage, ["/repo/src/main.ts"]);
    assert.deepEqual(plan.commit.filesToRemove, []);
    assert.equal(plan.commit.subject, "auto(abcdef12): write src/main.ts");
    assert.equal(
      plan.commit.body,
      "Session: abcdef12-3456-7890-abcd-ef1234567890",
    );
  });

  it("uses tool_name in subject", () => {
    const input = makeInput({ tool_name: "Edit" });
    const state = makeState();
    const plan = planHook(input, state);
    if (plan.action !== "commit-and-sync") return;
    assert.match(plan.commit.subject, /^auto\(abcdef12\): edit src\/main\.ts$/);
  });

  it("defaults tool_name to 'update'", () => {
    const input = makeInput({ tool_name: null });
    const state = makeState();
    const plan = planHook(input, state);
    if (plan.action !== "commit-and-sync") return;
    assert.match(plan.commit.subject, /update src\/main\.ts/);
  });

  it("handles deletion path", () => {
    const input = makeInput({ tool_input: {} });
    const state = makeState({
      deletedFiles: ["old.ts", "stale.ts", "gone.ts"],
      relPath: null,
    });
    const plan = planHook(input, state);
    if (plan.action !== "commit-and-sync") return;
    assert.deepEqual(plan.commit.filesToStage, []);
    assert.deepEqual(plan.commit.filesToRemove, ["old.ts", "stale.ts", "gone.ts"]);
    assert.match(plan.commit.subject, /delete old\.ts \(\+2 more\)/);
  });

  it("sync is null when no remote", () => {
    const input = makeInput();
    const state = makeState({ hasRemote: false });
    const plan = planHook(input, state);
    if (plan.action !== "commit-and-sync") return;
    assert.equal(plan.sync, null);
  });

  it("includes sync plan on worktree branch", () => {
    const input = makeInput();
    const state = makeState({ currentBranch: "trunk-sync-abc" });
    const plan = planHook(input, state);
    if (plan.action !== "commit-and-sync") return;
    assert.deepEqual(plan.sync, { targetBranch: "main", currentBranch: "trunk-sync-abc" });
  });

  it("body is null when no session or transcript", () => {
    const input = makeInput({ session_id: null, transcript_path: null });
    const state = makeState();
    const plan = planHook(input, state);
    if (plan.action !== "commit-and-sync") return;
    assert.equal(plan.commit.body, null);
  });
});

// ── buildCommitPlanWithTask ──────────────────────────────────────────

describe("buildCommitPlanWithTask", () => {
  it("uses task as subject when provided", () => {
    const input = makeInput();
    const state = makeState();
    const commit = buildCommitPlanWithTask(input, state, "Fix the broken tests");
    assert.equal(commit.subject, "auto(abcdef12): Fix the broken tests");
    assert.match(commit.body!, /^File: src\/main\.ts/);
    assert.match(commit.body!, /Session: abcdef12/);
    assert.ok(!commit.body!.includes("Transcript:"));
  });

  it("falls back to default plan when task is null", () => {
    const input = makeInput();
    const state = makeState();
    const commit = buildCommitPlanWithTask(input, state, null);
    assert.match(commit.subject, /write src\/main\.ts/);
  });
});

// ── buildSessionPrefix ──────────────────────────────────────────────

describe("buildSessionPrefix", () => {
  it("includes short session id", () => {
    assert.equal(buildSessionPrefix("abcdef1234567890"), "auto(abcdef12): ");
  });

  it("returns plain auto: when null", () => {
    assert.equal(buildSessionPrefix(null), "auto: ");
  });
});

// ── buildCommitBody ──────────────────────────────────────────────────

describe("buildCommitBody", () => {
  it("includes session only", () => {
    const input = makeInput();
    const body = buildCommitBody(input, "src/main.ts");
    assert.equal(body, "Session: abcdef12-3456-7890-abcd-ef1234567890");
  });

  it("returns null when no session", () => {
    const input = makeInput({ session_id: null });
    assert.equal(buildCommitBody(input, "src/main.ts"), null);
  });
});

// ── extractTaskFromTranscript ────────────────────────────────────────

describe("extractTaskFromTranscript", () => {
  it("extracts first user message", () => {
    const content = jsonl({ type: "user", message: { role: "user", content: "Fix the login bug" } });
    assert.equal(extractTaskFromTranscript(content), "Fix the login bug");
  });

  it("skips hook feedback lines", () => {
    const content = jsonl({
      type: "user",
      message: { role: "user", content: "Stop hook feedback: some error" },
    });
    assert.equal(extractTaskFromTranscript(content), null);
  });

  it("skips 'Implement the following plan:' header", () => {
    const content = jsonl({
      type: "user",
      message: { role: "user", content: "Implement the following plan:\n\nDo the thing" },
    });
    assert.equal(extractTaskFromTranscript(content), "Do the thing");
  });

  it("skips XML tags", () => {
    const content = jsonl({
      type: "user",
      message: { role: "user", content: "<context>\nActual task" },
    });
    assert.equal(extractTaskFromTranscript(content), "Actual task");
  });

  it("strips markdown headers", () => {
    const content = jsonl({
      type: "user",
      message: { role: "user", content: "## My Feature Request" },
    });
    assert.equal(extractTaskFromTranscript(content), "My Feature Request");
  });

  it("truncates at 72 chars", () => {
    const longMsg = "A".repeat(100);
    const content = jsonl({ type: "user", message: { role: "user", content: longMsg } });
    assert.equal(extractTaskFromTranscript(content)!.length, 72);
  });

  it("handles array content", () => {
    const content = jsonl({
      type: "user",
      message: { role: "user", content: ["First part", "Second part"] },
    });
    assert.equal(extractTaskFromTranscript(content), "First part");
  });

  it("skips non-user messages", () => {
    const content = jsonl({ type: "assistant", message: { role: "assistant", content: "Sure" } });
    assert.equal(extractTaskFromTranscript(content), null);
  });

  it("returns null for empty content", () => {
    assert.equal(extractTaskFromTranscript(""), null);
  });

  it("handles invalid JSON lines gracefully", () => {
    const content = "not json\n" + jsonl({
      type: "user",
      message: { role: "user", content: "Real task" },
    });
    assert.equal(extractTaskFromTranscript(content), "Real task");
  });

});

// ── summarizeDeletions ───────────────────────────────────────────────

describe("summarizeDeletions", () => {
  it("returns empty for no files", () => {
    assert.equal(summarizeDeletions([]), "");
  });

  it("returns filename for single file", () => {
    assert.equal(summarizeDeletions(["file.ts"]), "file.ts");
  });

  it("summarizes multiple files", () => {
    assert.equal(summarizeDeletions(["a.ts", "b.ts", "c.ts"]), "a.ts (+2 more)");
  });
});

// ── Helper ───────────────────────────────────────────────────────────

function jsonl(...objects: unknown[]): string {
  return objects.map((o) => JSON.stringify(o)).join("\n");
}
