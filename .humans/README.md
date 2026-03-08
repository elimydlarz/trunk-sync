# trunk-sync — Developer Guide

Run multiple Claude Code agents on the same repo without breaking each other's work, and understand any line of generated code on demand.

**Trunk-Sync** — maximum continuous integration for coding agents. Agents work in parallel — on local worktrees, across remote machines, any mix — with agentic conflict resolution. No more wasted time resolving conflicts by hand, remembering to commit, or discovering that an agent never pushed its work.

**Seance** — talk to dead coding agents. Point at any line of code and rewind the codebase and session back to the exact moment it was written. Ask the agent what it was thinking. Understand generated code on demand — stop worrying about keeping up with every change your agents make.

## Architecture

trunk-sync is a Claude Code plugin with two independent layers that share one git repo:

### Plugin layer (the hook)

Auto-commits and pushes every file write, enabling multiple agents to work on the same branch simultaneously. Each agent runs in its own git worktree (`claude -w`), isolated from other agents, but continuously integrating to `origin/main`.

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

### CLI layer (TypeScript)

A thin CLI (`trunk-sync`) with two commands:
- `install` — precondition checks (git repo, remote, jq, claude), adds the GitHub repo as a marketplace source, then installs the plugin via `claude plugin install` (default project scope, `--scope user` for all repos)
- `seance` — traces a line of code back to the Claude session that wrote it and resumes that conversation

```
src/cli.ts                   — entry point, argv dispatch
src/commands/install.ts      — trunk-sync install (preconditions + marketplace add + plugin install)
src/commands/seance.ts       — trunk-sync seance (blame → session ID → rewind → resume)
src/lib/git.ts               — shared git utilities
src/lib/git.test.ts          — unit tests (node:test)
src/commands/seance.test.ts  — integration tests (node:test)
```

Both layers are independent. The plugin works without the CLI, and the CLI delegates to `claude plugin install` for actual installation. The only coupling: the hook writes `Session:` and `Transcript:` into every commit body, and seance reads them back.

## Trunk-Sync — how it works

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

### Commit messages

The hook extracts the user's initial prompt from the session transcript (parsed from JSONL):

```
auto(877a28bc): refactor the auth module to use JWT
auto(bdb0f3fe): fix the login page redirect bug
auto(abc12345): edit src/main.ts                     (fallback when no transcript)
```

The hex prefix is derived from the session ID. Find all commits from one session: `git log --grep='877a28bc'`

## Seance — how it works

Every trunk-sync commit embeds `Session: <uuid>` and `Transcript: <path>` in the commit body. Seance uses these to trace a line of code back to the agent that wrote it:

1. `git blame` finds the commit that last touched the target line
2. The session ID and transcript path are extracted from the commit body
3. The transcript is truncated to the commit's timestamp — rewinding to that exact moment
4. A worktree is created at the blamed commit so the code matches what the agent saw
5. The session ID and cwd inside the JSONL entries are rewritten to match the new worktree
6. Claude resumes with `--resume`, picking up with the same context it had when it wrote the line

The resumed agent is restricted to **read-only tools** (`--allowedTools`) and given a system prompt enforcing seance mode — it can explain and explore but not edit, write, or create files.

### Modes

```bash
# Default — rewind and resume the session (read-only)
trunk-sync seance src/main.ts:42

# Inspect — print commit SHA, subject, and session ID without launching Claude
trunk-sync seance src/main.ts:42 --inspect

# List — deduplicate sessions from git history and print a table
trunk-sync seance --list
```

### Fallback for older commits

If the commit body has no `Transcript:` field (older commits before transcript recording), seance falls back to `--resume <id> --fork-session` which forks from the end of the session. Less precise, but still useful.

### Cleanup

The temporary rewound transcript file and the worktree are both cleaned up when Claude exits.

## Development

### Prerequisites

- `jq` at runtime

### Tests

```bash
# Hook tests (shell, TAP output)
bash test/trunk-sync.test.sh

# CLI tests (TypeScript, node:test)
pnpm run build && pnpm test
```

Hook tests create isolated temp repos with worktrees and a bare remote to simulate multi-agent scenarios. Safe to run anywhere — no network access needed.

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
