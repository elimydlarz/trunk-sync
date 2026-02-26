# Trunk Sync

Every file write is auto-committed and pushed by a PostToolUse hook. This keeps multiple agents in sync on trunk.

## How it works

Each agent runs in its own git worktree (via `claude -w`), isolated from other agents. After every `Edit` or `Write`, the hook:

1. Commits the changed file with agent context
2. Pulls from `origin/main` (`--no-rebase`) and pushes to `origin main`
3. Retries once if another agent pushed between pull and push

If another agent changed the same file, you get a merge conflict — same mechanism whether the change came from a local worktree or a remote machine.

## When you see TRUNK-SYNC CONFLICT

Another agent changed the same file. Git left conflict markers in the file. Just read the file, edit it to the correct content (remove the `<<<<<<<` / `=======` / `>>>>>>>` markers), and the hook will detect the merge state and complete the sync automatically on your next edit.

Do NOT run git commands to resolve — just fix the file contents.

## Don't

- Make manual git commits — the hook handles it
- Run `git pull` or `git push` yourself — the hook handles it
