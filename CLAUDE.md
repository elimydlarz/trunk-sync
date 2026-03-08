# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Mental Model

trunk-sync has two independent layers that share one git repo:

**Hook layer** — a Claude Code plugin (shell script) that fires after every Edit/Write tool use. It stages, commits, pulls from `origin/main`, and pushes — keeping multiple agents in continuous integration. Merge conflicts are surfaced as hook feedback (exit 2); the agent resolves by editing the file, and the hook completes the merge on the next fire.

**CLI layer** — a TypeScript CLI (`trunk-sync`) with two commands:
- `install` — precondition checks (git repo, remote, jq, claude) then delegates to `claude plugin install`
- `seance` — traces a line of code via `git blame` → commit body → `Session:` + `Transcript:` fields → truncates the session transcript to that commit's timestamp → creates a worktree at that commit → resumes the rewound session so Claude has the same context it had when it wrote the code

The hook writes `Session: <uuid>` and `Transcript: <path>` into every commit body. Seance reads both back. This is the only coupling between the two layers.

Key domain concepts: worktree (each agent gets one via `claude -w`), trunk (always `origin/main`), session ID (links commits to Claude conversations).

## Repo Map

```
.claude-plugin/plugin.json   — plugin manifest (name, version)
hooks/hooks.json              — hook registration (Edit|Write → scripts/trunk-sync.sh)
scripts/trunk-sync.sh         — the hook script (reads JSON stdin, stages/commits/pulls/pushes)
rules/trunk-sync.md           — agent-facing rules (don't manual-commit, etc.)

src/cli.ts                    — CLI entry point, argv dispatch
src/commands/install.ts       — trunk-sync install
src/commands/seance.ts        — trunk-sync seance (default/--inspect/--list modes)
src/lib/git.ts                — shared git utilities (blame, parseFileRef, extractSessionId, etc.)
src/lib/git.test.ts           — unit tests (node:test)
src/commands/seance.test.ts   — integration tests (node:test)

test/trunk-sync.test.sh       — hook test suite (TAP, temp repos + bare remote)
test/local-setup.sh           — manual test setup
test/local-cleanup.sh         — manual test teardown
```

## Requirements

- **auto-commit**: every Edit/Write fires the hook, which stages and commits the changed file
- **auto-sync**: after commit, pull from origin/main (--no-rebase) then push HEAD:main
- **conflict-feedback**: merge conflicts exit 2 with self-contained instructions for the agent
- **conflict-resolve**: if MERGE_HEAD exists, the hook completes the merge (agent already edited)
- **push-retry**: one automatic pull+push retry on push failure
- **deletion-sync**: deleted tracked files are staged and committed when the hook fires with no file_path
- **session-trace**: commit body includes `Session: <uuid>` for seance lookback
- **transcript-enrich**: commit subject extracted from session transcript's first user message
- **transcript-path**: commit body includes `Transcript: <path>` so seance can locate and rewind the session file
- **install-preconditions**: CLI checks git repo, remote, jq, claude before installing
- **seance-inspect**: `--inspect` prints commit SHA, subject, session ID without launching claude
- **seance-list**: `--list` deduplicates sessions from `git log --grep` and prints a table
- **seance-rewind**: default mode truncates the session transcript to the blamed commit's timestamp, writes it as a new session file in the worktree's project directory (`~/.claude/projects/<worktree-slug>/`), rewrites `sessionId` and `cwd` fields inside the JSONL entries to match the new session ID and worktree path, and resumes from that point — so the forked Claude has the same context it had when it wrote the code. The file must be in the worktree's project directory (not the original project's) because Claude resolves `--resume` relative to the cwd's project slug, and the internal `sessionId` must match the filename.
- **seance-rewind-fallback**: if no `Transcript:` field in commit body (older commits), falls back to `--resume <id> --fork-session` (forks from end of session)
- **seance-rewind-cleanup**: the temporary rewound transcript file is deleted after Claude exits
- **seance-read-only**: resumed agent is restricted to read-only tools (`--allowedTools`) and given a system prompt (`--append-system-prompt`) enforcing seance mode — it cannot edit, write, or create files

## Development

### Tests

```bash
# Hook tests (shell, TAP output)
bash test/trunk-sync.test.sh

# CLI tests (TypeScript, node:test)
pnpm run build && pnpm test
```

Hook tests create isolated temp repos with worktrees and a bare remote. Safe to run anywhere — no network access needed.

### Building the CLI

```bash
pnpm run build        # compile TypeScript → dist/
pnpm run dev -- <cmd> # run from source via tsx
```

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

### Key conventions

- Hook requires `jq` at runtime
- CLI has zero runtime dependencies — only devDependencies (typescript, tsx, @types/node)
- All TypeScript imports use `.js` extensions (Node16 ESM requirement)
- Hook exit codes: 0 = success/no-op, 2 = conflict/failure with agent feedback on stderr
