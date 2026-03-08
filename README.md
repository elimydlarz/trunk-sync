# trunk-sync

Maximum continuous integration for multi-agent coding. Every file edit is committed and pushed to `origin/main` immediately — multiple agents work simultaneously in git worktrees, continuously integrating every change.

## Quick start

```bash
npm install -g trunk-sync
trunk-sync install
```

This adds the trunk-sync marketplace and installs the plugin at **project scope** (active in the current repo only). To install at **user scope** (active in all repos):

```bash
trunk-sync install --scope user
```

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- `jq` on the machine running Claude Code
- A git repo with a remote (`origin`)

### What gets installed

```
scripts/trunk-sync.sh     — the hook script
hooks/hooks.json           — registers the hook on Edit|Write
rules/trunk-sync.md        — tells agents not to make manual commits
```

### Scopes

| Scope | Config location | Effect |
|-------|----------------|--------|
| `project` (default) | `.claude/plugins.json` | Active in this repo only — committed to git so collaborators get it too |
| `user` | `~/.claude/plugins.json` | Active in all repos for this user |

## Running multiple agents

```bash
claude -w    # each invocation gets its own worktree
```

Launch as many as you need. They all push to the same trunk.

## How it works

After every `Edit` or `Write` tool use, the hook:

1. Stages and commits the changed file
2. Pulls from `origin/main` (`--no-rebase`)
3. Pushes `HEAD` to `origin/main`
4. Retries once if another agent pushed between pull and push
5. On merge conflict, tells the agent to resolve by editing the file normally

The hook works from any branch — `main`, a worktree branch, or anything else. It always syncs against `origin/main`.

## Conflicts

When two agents edit the same file, `git pull` produces a merge conflict. The hook tells the agent the file has conflict markers (exit code 2). The agent reads the file, edits out the markers normally, and the hook completes the merge automatically.

No git commands needed — just edit the file.

## Seance — talk to the agent that wrote a line

trunk-sync records the Claude session ID in every commit. `seance` traces a line of code back to the session that wrote it and lets you resume that conversation.

```bash
# See which session wrote line 42 of src/main.ts
trunk-sync seance src/main.ts:42 --inspect

# Resume that session to continue the conversation
trunk-sync seance src/main.ts:42

# List all trunk-sync sessions in the repo
trunk-sync seance --list
```

`seance` rewinds the session transcript to the exact point where the commit was made, creates a worktree at that commit, and resumes Claude with the same context it had when it wrote the code. The resumed agent is read-only — it can explain and explore but not edit.

## For humans

Developer docs, architecture, and testing: [.humans/README.md](.humans/README.md)
