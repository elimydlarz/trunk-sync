# trunk-sync

Run multiple Claude Code agents on the same repo without breaking each other's work, and understand any line of generated code on demand.

## Trunk-Sync — maximum continuous integration for coding agents

Every file edit is committed and pushed to `origin/main` automatically. Agents work in parallel — on local worktrees, across remote machines, any mix — with agentic conflict resolution. No more wasted time resolving conflicts by hand, remembering to commit, or discovering that an agent never pushed its work.

## Seance — talk to dead coding agents

Point at any line of code, and seance rewinds the codebase and the Claude session back to the exact moment that line was written. Ask the agent what it was thinking. Understand generated code easily, on demand — stop worrying about keeping up with every change your agents make.

## Quick start

```bash
npm install -g trunk-sync
trunk-sync install
```

This installs the plugin at **project scope** (active in the current repo only). To install at **user scope** (active in all repos):

```bash
trunk-sync install --scope user
```

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- `jq` on the machine running Claude Code
- A git repo with a remote (`origin`)

### Scopes

| Scope | Config location | Effect |
|-------|----------------|--------|
| `project` (default) | `.claude/plugins.json` | Active in this repo only — committed to git so collaborators get it too |
| `user` | `~/.claude/plugins.json` | Active in all repos for this user |

## Using Trunk-Sync

```bash
claude -w    # each invocation gets its own worktree
```

Launch as many agents as you need. They all push to the same trunk. After every `Edit` or `Write`, trunk-sync commits, pulls, and pushes — automatically. If two agents edit the same file, trunk-sync tells the agent to resolve the conflict by editing the file normally. No git commands, no manual merging.

## Using Seance

```bash
# Rewind and resume the session that wrote line 42
trunk-sync seance src/main.ts:42

# Just show which session wrote it, without launching Claude
trunk-sync seance src/main.ts:42 --inspect

# List all trunk-sync sessions in the repo
trunk-sync seance --list
```

Seance traces `git blame` back to the commit, rewinds the session transcript to that point, checks out the code at that commit, and resumes Claude with the same context it had when it wrote the line. The resumed agent is read-only — it explains and explores but cannot edit.

## Transcript commits

By default, seance finds session transcripts on the local filesystem (`~/.claude/projects/<slug>/<sessionId>.jsonl`). This works when you're tracing code written on the same machine, but the transcript won't exist if the code was written by an agent on a different machine, in CI, or if the local transcript has been cleaned up.

**Enable transcript commits** to solve this — each auto-commit will include a snapshot of the session transcript in `.transcripts/`, so the conversation travels with the code in git history:

```bash
trunk-sync config commit-transcripts true
```

With this enabled, seance can find the transcript directly in the commit via `git diff-tree`, regardless of which machine wrote the code. This is the recommended setup for teams and multi-machine workflows.

To disable:

```bash
trunk-sync config commit-transcripts false
```

### Security note

Transcripts contain your full conversation with Claude, which may include sensitive context, proprietary code discussions, or credentials you pasted into the chat. With `commit-transcripts=true`, these are committed to git — meaning anyone with repo access can read them. Encryption of snapshots before commit is a likely future addition, which would let transcripts hitch a ride on git without being readable in the clear. For now, only enable this on repos where you're comfortable with transcript visibility, or where access is already restricted.

## For humans

Developer docs, architecture, and testing: [.humans/README.md](.humans/README.md)
