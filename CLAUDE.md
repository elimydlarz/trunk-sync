# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development

### Tests

```bash
bash test/trunk-sync.test.sh
```

41 tests using TAP output. Tests create isolated temp repos with worktrees and a bare remote to simulate multi-agent scenarios. Safe to run anywhere — no network access needed.

### Manual testing

Scripts for testing the hook live against origin with real worktrees:

```bash
# 1. Setup — commits a file on local main without pushing
bash test/local-setup.sh

# 2. Launch two agents in worktrees
#    Terminal 1:
claude -w
#    Terminal 2:
claude -w

# 3. Give each agent a task that edits test/battlefield.txt
#    They will conflict on the same file and the hook will handle it.

# 4. Verify
git log --oneline origin/main   # should have auto-commits + local-only commit
git status                       # main should be clean and up to date
cat test/battlefield.txt         # should reflect the resolved content

# 5. Cleanup — resets local main and origin/main to pre-test state,
#    removes all worktrees and trunk-sync branches
bash test/local-cleanup.sh
```

`local-cleanup.sh` restores test files to their initial state and removes worktrees. The hook will commit and push the restored state on the next edit.

### Architecture

This repo is a Claude Code PostToolUse hook that auto-commits and pushes every file write, enabling multiple agents to work on the same branch simultaneously. Each agent runs in its own git worktree (via `claude -w`), isolated from other agents, but continuously integrating to `origin/main`.

This repo dogfoods itself — the `.claude/` directory is both the source code and the installed hook.

- `.claude/hooks/trunk-sync.sh` — the hook script, reads JSON from stdin (tool_input, session_id, transcript_path), stages/commits the changed file, pulls from origin/main, pushes HEAD to origin/main
- `.claude/settings.json` — hook registration (fires on Edit|Write)
- `.claude/rules/trunk-sync.md` — tells agents how to work with the hook
- `test/trunk-sync.test.sh` — test suite simulating worktree-based multi-agent git scenarios
- `CLAUDE.md` — development guide + installation instructions

### Key hook behaviors

- Exit 0: success or no-op (empty path, outside repo, gitignored, no changes)
- Exit 2: conflict or push failure — stderr message becomes agent feedback via hook protocol
- Commit messages are enriched from the session transcript's first user message (parsed from JSONL)
- Merge conflicts: if `MERGE_HEAD` exists, the hook assumes the agent resolved conflict markers and completes the merge commit
- Push retry: one automatic pull+push retry if the first push fails (another agent pushed between pull and push)
- Works from any branch: `git pull origin main --no-rebase` + `git push origin HEAD:main` — compatible with worktree branches and main alike

### Prerequisites

The hook requires `jq` at runtime.

---

# You're here to install trunk-sync

This repo contains a Claude Code hook. Your user wants you to install it into their project. Follow these steps exactly.

## Prerequisites

Verify `jq` is available on this machine — the hook requires it. The project must be a git repo with a remote configured (the hook pushes after every commit).

## Install steps

All paths below are relative to the user's project root (where you're working), NOT this repo.

### 1. Copy the hook script

```
mkdir -p .claude/hooks
```

Copy the contents of `.claude/hooks/trunk-sync.sh` from this repo into `.claude/hooks/trunk-sync.sh` in the target project. Make it executable (`chmod +x`).

### 2. Configure Claude Code to run the hook

If `.claude/settings.json` exists in the target project, merge the PostToolUse entry from this repo's `.claude/settings.json` into it. If it doesn't exist, copy `.claude/settings.json`.

The hook must fire on `Edit|Write` tool uses:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/trunk-sync.sh",
            "statusMessage": "Syncing to trunk"
          }
        ]
      }
    ]
  }
}
```

### 3. Add the agent rules file

Copy `.claude/rules/trunk-sync.md` from this repo into `.claude/rules/trunk-sync.md` in the target project.

### 4. Add .worktrees/ to .gitignore

If agents will use `claude -w` (worktree mode), add `.claude/worktrees/` to the project's `.gitignore`.

### 5. Commit the installed files

Stage and commit `.claude/hooks/trunk-sync.sh`, `.claude/settings.json`, and `.claude/rules/trunk-sync.md`. Use a descriptive commit message — this is a one-time setup commit, not an auto-commit.

## Running multiple agents

After installing, launch agents in worktree mode so each gets an isolated working directory:

```bash
claude -w    # each invocation gets its own worktree
```

Every edit is committed and pushed to `origin/main`. Conflicts between agents are surfaced as merge conflicts — the agent resolves them by editing the file normally.

## What trunk-sync does

After every `Edit` or `Write`, the hook automatically:

1. Stages and commits the changed file with an enriched commit message (extracts the task from the session transcript)
2. Pulls from `origin/main` (merge, no rebase) — brings in other agents' work
3. Pushes `HEAD` to `origin/main` — shares this agent's work
4. Retries once if another agent pushed between pull and push
5. On merge conflict, sends feedback to the agent with instructions to resolve by editing the file normally

This works from any branch — `main`, a worktree branch, or anything else. The hook always syncs against `origin/main`.
