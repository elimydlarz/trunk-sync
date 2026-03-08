# trunk-sync

Two tools for multi-agent coding with Claude Code:

**Trunk-Sync** — continuous integration. Every file edit is committed and pushed to `origin/main` immediately. Multiple agents work simultaneously in git worktrees, continuously integrating every change.

**Seance** — talk to the agent that wrote a line. Point at any line of code and resume the Claude session that wrote it, rewound to that exact moment. Ask it *why*.

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

## Trunk-Sync

### Running multiple agents

```bash
claude -w    # each invocation gets its own worktree
```

Launch as many as you need. They all push to the same trunk.

### How it works

After every `Edit` or `Write` tool use, the hook:

1. Stages and commits the changed file
2. Pulls from `origin/main` (`--no-rebase`)
3. Pushes `HEAD` to `origin/main`
4. Retries once if another agent pushed between pull and push
5. On merge conflict, tells the agent to resolve by editing the file normally

The hook works from any branch — `main`, a worktree branch, or anything else. It always syncs against `origin/main`.

### Conflicts

When two agents edit the same file, `git pull` produces a merge conflict. The hook tells the agent the file has conflict markers (exit code 2). The agent reads the file, edits out the markers normally, and the hook completes the merge automatically.

No git commands needed — just edit the file.

## Seance

Every trunk-sync commit records the Claude session ID and transcript path. Seance uses this to trace any line of code back to the agent that wrote it.

```bash
# Resume the session that wrote line 42 — rewound to that moment
trunk-sync seance src/main.ts:42

# Inspect without launching Claude
trunk-sync seance src/main.ts:42 --inspect

# List all trunk-sync sessions in the repo
trunk-sync seance --list
```

### How it works

1. `git blame` finds the commit that last touched the line
2. The commit body contains the session ID and transcript path
3. The transcript is truncated to the commit's timestamp — rewound to that exact point
4. A worktree is created at the blamed commit so the code matches
5. Claude resumes with the same context it had when it wrote the line

The resumed agent is **read-only** — it can explain and explore but not edit. When you exit, the worktree and temporary transcript are cleaned up.

If the commit predates transcript recording, seance falls back to forking from the end of the session (less precise but still useful).

## For humans

Developer docs, architecture, and testing: [.humans/README.md](.humans/README.md)
