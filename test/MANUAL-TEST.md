# Manual testing

## Setup

```bash
bash test/local-setup.sh
```

This commits `test/local-only.txt` on your local main without pushing it to origin. This lets you verify that the hook picks up local-only commits and pushes them along with agent edits.

## Run two agents

Open two terminals and launch a worktree agent in each:

```bash
claude -w
```

Paste a task into each. These two will conflict on the same file:

**Terminal 1:**
```
Edit test/battlefield.txt to reflect that the Grand Hotel has been heritage-listed and preserved as a time capsule. Add details about the preservation order, the museum tours now running through the lobby, the original furnishings being restored, the restaurant serving Helena Westwood's original 1923 menu, and the penthouse kept exactly as it was on the night of the jewel theft. The tone should be reverent.
```

**Terminal 2:**
```
Edit test/battlefield.txt to reflect that the Grand Hotel was demolished in 2024 to make way for a McDonald's. Rewrite each section to describe the demolition, what replaced it — the drive-through where the lobby was, the PlayPlace where the penthouse was, the McFlurry machine that's always broken where the wine cellar was. The tone should be tragic.
```

## What to watch for

- Both agents show "Syncing to trunk" after each edit
- One agent gets a TRUNK-SYNC CONFLICT and resolves it by re-reading and re-editing the file
- `test/local-only.txt` appears on origin (the hook picked up the unpushed local commit)
- Your local main stays in sync — `git status` should show no divergence from origin

## Verify

```bash
git log --oneline -10          # auto-commits from both agents, plus local-only commit
git status                     # main should be up to date with origin
cat test/battlefield.txt       # final content after conflict resolution
git log --oneline origin/main  # local-only commit should be here too
```

## Cleanup

```bash
bash test/local-cleanup.sh
```

Removes all worktrees and worktree branches, restores test files to their initial state.
