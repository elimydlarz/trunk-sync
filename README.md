# trunk-sync

A Claude Code plugin that auto-commits and pushes every file edit, keeping multiple agents in sync on a shared branch.

Each agent runs in its own git worktree (`claude -w`), fully isolated from other agents. The plugin continuously integrates every edit to `origin/main` — same mechanism whether the conflicting change came from a local worktree or a remote machine.

## Install

```
/plugin install github:elimydlarz/trunk-sync
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

The hook works from any branch — `main`, a worktree branch, or anything else. It always syncs against `origin/main`.

## How conflicts work

When two agents edit the same file, `git pull` produces a merge conflict. The hook sends feedback (exit code 2) telling the agent the file has conflict markers. The agent reads the file, removes the markers with a normal edit, and the hook detects the merge state and completes the sync automatically.

No manual git intervention needed.

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
