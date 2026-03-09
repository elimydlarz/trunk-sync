# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Mental Model

trunk-sync has two independent layers that share one git repo:

**Hook layer** — a Claude Code plugin that fires after every Edit/Write tool use. It stages, commits, pulls from `origin/main`, and pushes — keeping multiple agents in continuous integration. The logic is implemented in TypeScript (functional core in `hook-plan.ts`, imperative shell in `hook-execute.ts`) and invoked via a thin bash wrapper (`scripts/trunk-sync.sh → node dist/lib/hook-entry.js`). Merge conflicts are surfaced as hook feedback (exit 2); the agent resolves by editing the file, and the hook completes the merge on the next fire.

**CLI layer** — a TypeScript CLI (`trunk-sync`) with three commands:
- `install` — soft checks (git repo warns, missing remote is silent), hard checks (jq, claude), adds the GitHub repo as a marketplace source, then installs the plugin via `claude plugin install` (default project scope, `--scope user` for all repos)
- `seance` — traces a line of code via `git blame` → commit body → `Session:` field → derives transcript path from repo root + session ID → truncates the session transcript to that commit's timestamp → creates a worktree at that commit → resumes the rewound session so Claude has the same context it had when it wrote the code
- `config` — reads/writes `~/.trunk-sync` config file (key=value format)

The hook writes `Session: <uuid>` into every commit body. Seance reads it back and derives the transcript path (`~/.claude/projects/<project-slug>/<uuid>.jsonl`) from the repo root and session ID. This is the only coupling between the two layers. When `commit-transcripts=true` in `~/.trunk-sync`, the hook also snapshots the transcript into `.transcripts/` and amends the code commit — seance finds these via `git diff-tree`, falling back to the derived filesystem path.

Key domain concepts: worktree (each agent gets one via `claude -w`), trunk (always `origin/main`), session ID (links commits to Claude conversations).

## Repo Map

```
.claude-plugin/plugin.json    — plugin manifest (name, version)
hooks/hooks.json              — hook registration (Edit|Write|Bash → scripts/trunk-sync.sh)
scripts/trunk-sync.sh         — 4-line bash wrapper: exec node dist/lib/hook-entry.js
rules/trunk-sync.md           — agent-facing rules (don't manual-commit, etc.)

src/lib/hook-types.ts         — types (HookInput, RepoState, HookPlan)
src/lib/hook-plan.ts          — pure decision logic (no I/O, no git)
src/lib/hook-plan.test.ts     — unit tests for pure logic (fast, no repos)
src/lib/hook-execute.ts       — gathers git state, executes the plan
src/lib/hook-execute.test.ts  — integration tests (temp repos)
src/lib/hook-entry.ts         — entry point: reads stdin, wires layers, exits

src/cli.ts                    — CLI entry point, argv dispatch
src/commands/install.ts       — trunk-sync install
src/commands/seance.ts        — trunk-sync seance (default/--inspect/--list modes)
src/commands/config.ts        — trunk-sync config (read/write ~/.trunk-sync)
src/commands/config.test.ts   — config command tests (node:test)
.transcripts/                 — opt-in session snapshots committed by hook
src/lib/git.ts                — shared git utilities (blame, parseFileRef, extractSessionId, findSnapshotInCommit)
src/lib/git.test.ts           — unit tests (node:test)
src/commands/seance.test.ts   — integration tests (node:test)

test/trunk-sync.test.sh       — hook e2e test suite (TAP, temp repos + bare remote)
test/local-setup.sh           — manual test setup
test/local-cleanup.sh         — manual test teardown
```

## Requirements

- **auto-commit**: every Edit/Write fires the hook, which stages and commits the changed file (works on any branch, not just main)
- **auto-sync**: after commit, pull from origin's default branch (--no-rebase) then push HEAD to it; silently skipped when no remote is configured
- **conflict-feedback**: merge conflicts exit 2 with self-contained instructions for the agent
- **conflict-resolve**: if MERGE_HEAD exists, the hook completes the merge (agent already edited)
- **push-retry**: one automatic pull+push retry on push failure
- **deletion-sync**: deleted tracked files are staged and committed when the hook fires with no file_path
- **session-trace**: commit body includes `Session: <uuid>` for seance lookback
- **transcript-enrich**: commit subject extracted from session transcript's first user message
- **install-preconditions**: CLI hard-checks jq and claude; warns if no git repo; silently accepts missing remote
- **graceful-no-git**: hook exits 0 (no-op) when not inside a git repo
- **graceful-no-remote**: hook commits locally and silently skips pull/push when no remote is configured
- **install-marketplace**: CLI adds the GitHub repo as a marketplace source before installing the plugin
- **install-scope**: default project scope (`.claude/plugins.json`), `--scope user` for all repos (`~/.claude/plugins.json`)
- **seance-inspect**: `--inspect` prints commit SHA, subject, session ID without launching claude
- **seance-list**: `--list` deduplicates sessions from `git log --grep` and prints a table
- **seance-rewind**: default mode truncates the session transcript to the blamed commit's timestamp, writes it as a new session file in the worktree's project directory (`~/.claude/projects/<worktree-slug>/`), rewrites `sessionId` and `cwd` fields inside the JSONL entries to match the new session ID and worktree path, and resumes from that point — so the forked Claude has the same context it had when it wrote the code. The file must be in the worktree's project directory (not the original project's) because Claude resolves `--resume` relative to the cwd's project slug, and the internal `sessionId` must match the filename.
- **seance-rewind-cleanup**: the temporary rewound transcript file is deleted after Claude exits
- **seance-read-only**: resumed agent is restricted to read-only tools (`--allowedTools`) and given a system prompt (`--append-system-prompt`) enforcing seance mode — it cannot edit, write, or create files
- **config-file**: `~/.trunk-sync` stores user config as key=value; managed via `trunk-sync config`
- **transcript-snapshot**: when `commit-transcripts=true`, hook copies transcript to `.transcripts/` and amends the code commit to include it
- **snapshot-lookup**: seance finds snapshot via `git diff-tree` on the code commit, falls back to derived transcript path (`~/.claude/projects/<slug>/<sessionId>.jsonl`)

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

### Publishing

Two distribution channels — both must be updated together:

```bash
# 1. Bump version in both manifests
#    - package.json (npm)
#    - .claude-plugin/plugin.json (plugin)

# 2. Publish to npm (prepublishOnly runs the build)
pnpm publish

# 3. Push to GitHub (plugin installs from repo root)
git push origin main
```

The npm package includes the plugin files (`scripts/`, `hooks/`, `rules/`, `.claude-plugin/`) alongside the CLI (`dist/`). Test files are excluded from the tarball.


### Key conventions

- Hook no longer requires `jq` at runtime (TypeScript handles JSON parsing); `jq` is still checked by `install` command
- CLI has zero runtime dependencies — only devDependencies (typescript, tsx, @types/node)
- All TypeScript imports use `.js` extensions (Node16 ESM requirement)
- Hook exit codes: 0 = success/no-op, 2 = conflict/failure with agent feedback on stderr
