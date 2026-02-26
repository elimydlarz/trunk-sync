# trunk-sync

Maximum continuous integration for multi-agent coding. Every file edit is committed and pushed to `origin/main` immediately — not per-task, not per-session, every single edit.

Agents run in git worktrees (`claude -w`), fully isolated from each other. Whether two agents collide on the same file from worktrees on one machine or from separate machines across the world, the conflict resolution works identically: git merge conflicts, agent edits out the markers, hook completes the merge.

## Install

```bash
# Add the marketplace (one-time)
claude plugin marketplace add elimydlarz/trunk-sync

# Install (use --scope project to share with your team via .claude/settings.json)
claude plugin install trunk-sync@trunk-sync --scope project
```

## Prerequisites

- `jq` on the machine running Claude Code
- A git repo with a remote (the hook pushes after every commit)

## Running multiple agents

```bash
claude -w    # each invocation gets its own worktree
```

## How it works

After every `Edit` or `Write` tool use, the hook:

1. Stages and commits the changed file with an enriched commit message
2. Pulls from `origin/main` (`--no-rebase`) — merges in other agents' work
3. Pushes `HEAD` to `origin/main` — shares this agent's work
4. Retries once if another agent pushed between pull and push
5. On merge conflict, tells the agent to resolve by editing the file normally

Every edit is integrated immediately, so agents always work against near-current trunk. The longer you wait to integrate, the harder conflicts get — trunk-sync makes the wait zero.

The hook works from any branch — `main`, a worktree branch, or anything else. It always syncs against `origin/main`.

## How conflicts work

When two agents edit the same file, `git pull` produces a merge conflict. The hook sends feedback (exit code 2) telling the agent the file has conflict markers. The agent reads the file, removes the markers with a normal edit, and the hook detects the merge state and completes the sync automatically.

This works identically regardless of topology — two worktrees on one laptop, ten agents spread across CI runners, or any mix. The conflict path is always: git merge conflict → agent edits the file → hook completes the merge. No manual git intervention needed.

## Commit messages

The hook extracts the user's initial prompt from the session transcript:

```
auto(877a28bc): refactor the auth module to use JWT
auto(bdb0f3fe): fix the login page redirect bug
auto(abc12345): edit src/main.ts                     (fallback when no transcript)
```

Find all commits from one session: `git log --grep='877a28bc'`

## What gets installed

```
scripts/trunk-sync.sh     — the hook script
hooks/hooks.json           — registers the hook on Edit|Write
rules/trunk-sync.md        — tells agents not to make manual commits
```

## Tests

```bash
bash test/trunk-sync.test.sh
```

41 tests, TAP output, isolated temp repos with worktrees. Safe to run anywhere.
