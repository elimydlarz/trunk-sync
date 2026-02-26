# trunk-sync

Auto-commit and push every file edit to `origin/main`. Multiple agents work simultaneously in git worktrees, continuously integrating every change.

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

1. Stages and commits the changed file
2. Pulls from `origin/main` (`--no-rebase`)
3. Pushes `HEAD` to `origin/main`
4. Retries once if another agent pushed between pull and push
5. On merge conflict, tells you to resolve by editing the file normally

The hook works from any branch — `main`, a worktree branch, or anything else. It always syncs against `origin/main`.

## How conflicts work

When two agents edit the same file, `git pull` produces a merge conflict. The hook tells you the file has conflict markers (exit code 2). Read the file, edit out the markers normally, and the hook completes the merge automatically.

You don't need to run any git commands — just edit the file.

## What gets installed

```
scripts/trunk-sync.sh     — the hook script
hooks/hooks.json           — registers the hook on Edit|Write
rules/trunk-sync.md        — tells agents not to make manual commits
```

## For humans

Developer docs, architecture, and testing: [.humans/README.md](.humans/README.md)
