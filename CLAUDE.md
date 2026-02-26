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

This repo is a Claude Code plugin that auto-commits and pushes every file write, enabling multiple agents to work on the same branch simultaneously. Each agent runs in its own git worktree (via `claude -w`), isolated from other agents, but continuously integrating to `origin/main`.

- `.claude-plugin/plugin.json` — plugin manifest (name, version, hooks reference)
- `hooks/hooks.json` — hook registration (fires on Edit|Write, references the script via `${CLAUDE_PLUGIN_ROOT}`)
- `scripts/trunk-sync.sh` — the hook script, reads JSON from stdin (tool_input, session_id, transcript_path), stages/commits the changed file, pulls from origin/main, pushes HEAD to origin/main
- `rules/trunk-sync.md` — tells agents how to work with the hook
- `test/trunk-sync.test.sh` — test suite simulating worktree-based multi-agent git scenarios
- `CLAUDE.md` — development guide

### Key hook behaviors

- Exit 0: success or no-op (empty path, outside repo, gitignored, no changes)
- Exit 2: conflict or push failure — stderr message becomes agent feedback via hook protocol
- Commit messages are enriched from the session transcript's first user message (parsed from JSONL)
- Merge conflicts: if `MERGE_HEAD` exists, the hook assumes the agent resolved conflict markers and completes the merge commit
- Push retry: one automatic pull+push retry if the first push fails (another agent pushed between pull and push)
- Works from any branch: `git pull origin main --no-rebase` + `git push origin HEAD:main` — compatible with worktree branches and main alike

### Prerequisites

The hook requires `jq` at runtime.
