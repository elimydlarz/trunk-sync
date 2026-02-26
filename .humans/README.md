# trunk-sync — Developer Guide

Maximum continuous integration for multi-agent coding. Every file edit is committed and pushed to `origin/main` immediately — not per-task, not per-session, every single edit.

The longer you wait to integrate, the harder conflicts get. trunk-sync makes the wait zero.

## Architecture

trunk-sync is a Claude Code plugin that auto-commits and pushes every file write, enabling multiple agents to work on the same branch simultaneously. Each agent runs in its own git worktree (`claude -w`), isolated from other agents, but continuously integrating to `origin/main`.

```
.claude-plugin/plugin.json  — plugin manifest (name, version, hooks reference)
hooks/hooks.json             — hook registration (fires on Edit|Write, references the
                               script via ${CLAUDE_PLUGIN_ROOT})
scripts/trunk-sync.sh        — the hook script, reads JSON from stdin (tool_input,
                               session_id, transcript_path), stages/commits the changed
                               file, pulls from origin/main, pushes HEAD to origin/main
rules/trunk-sync.md          — tells agents how to work with the hook
test/trunk-sync.test.sh      — test suite simulating worktree-based multi-agent git scenarios
CLAUDE.md                    — development guide for agents working on this repo
```

## How it works

After every `Edit` or `Write` tool use, the hook:

1. Stages and commits the changed file with an enriched commit message
2. Pulls from `origin/main` (`--no-rebase`) — merges in other agents' work
3. Pushes `HEAD` to `origin/main` — shares this agent's work
4. Retries once if another agent pushed between pull and push
5. On merge conflict, tells the agent to resolve by editing the file normally

The hook works from any branch — `main`, a worktree branch, or anything else. It always syncs against `origin/main` using `git pull origin main --no-rebase` and `git push origin HEAD:main`.

### Exit codes

- **Exit 0**: success or no-op (empty path, outside repo, gitignored, no changes)
- **Exit 2**: conflict or push failure — stderr message becomes agent feedback via the hook protocol

### Merge conflicts

When two agents edit the same file, `git pull` produces a merge conflict. The hook sends feedback (exit code 2) telling the agent the file has conflict markers. The agent reads the file, removes the markers with a normal edit, and the hook detects `MERGE_HEAD` and completes the merge commit automatically.

This works identically regardless of topology — two worktrees on one laptop, ten agents spread across CI runners, or any mix. The conflict path is always: git merge conflict → agent edits the file → hook completes the merge. No manual git intervention needed.

### Push retry

If the first push fails (another agent pushed between pull and push), the hook does one automatic pull+push retry.

## Commit messages

The hook extracts the user's initial prompt from the session transcript (parsed from JSONL):

```
auto(877a28bc): refactor the auth module to use JWT
auto(bdb0f3fe): fix the login page redirect bug
auto(abc12345): edit src/main.ts                     (fallback when no transcript)
```

The hex prefix is derived from the session ID. Find all commits from one session: `git log --grep='877a28bc'`

## Development

### Prerequisites

- `jq` at runtime

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
