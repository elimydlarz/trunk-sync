#!/bin/bash
set -euo pipefail

# PostToolUse hook: auto-commit and push on every file write.
# Keeps multiple coding agents in sync on trunk.
#
# Works from any branch — main, a worktree branch, or anything else.
# Always syncs against origin/main (pull merges main in, push targets main).

INPUT=$(cat)
FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
GIT_DIR=$(git rev-parse --git-dir)

# No file_path (e.g. Bash tool) — check for deleted tracked files, otherwise no-op
if [[ -z "$FILE_PATH" ]]; then
  DELETED=$(git -C "$REPO_ROOT" ls-files --deleted) || exit 0
  [[ -z "$DELETED" ]] && exit 0
  # Stage all deletions
  while IFS= read -r f; do
    git -C "$REPO_ROOT" rm --cached --quiet -- "$f" 2>/dev/null || true
  done <<< "$DELETED"
fi

if [[ -n "$FILE_PATH" ]]; then
  # Only sync files inside this repo
  case "$FILE_PATH" in
    "$REPO_ROOT"/*) ;;
    *) exit 0 ;;
  esac

  # Skip gitignored files
  if git check-ignore -q -- "$FILE_PATH"; then
    exit 0
  fi
fi

# Detect the default branch on origin (empty when no remote configured)
HAS_REMOTE=true
git remote get-url origin &>/dev/null || HAS_REMOTE=false

TARGET_BRANCH=""
if [[ "$HAS_REMOTE" == true ]]; then
  TARGET_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||') || true
  TARGET_BRANCH="${TARGET_BRANCH:-main}"
fi

# Extract agent context for enriched commit messages
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
TRANSCRIPT_PATH=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty')

ACTION=$(printf '%s' "${TOOL_NAME:-update}" | tr '[:upper:]' '[:lower:]')
if [[ -n "$FILE_PATH" ]]; then
  REL_PATH="${FILE_PATH#"$REPO_ROOT"/}"
else
  # Deletion path — summarize what was deleted
  DELETED_COUNT=$(git diff --cached --name-only --diff-filter=D | wc -l | tr -d ' ')
  REL_PATH="$(git diff --cached --name-only --diff-filter=D | head -1)"
  if [[ "$DELETED_COUNT" -gt 1 ]]; then
    REL_PATH="$REL_PATH (+$((DELETED_COUNT - 1)) more)"
  fi
  ACTION="delete"
fi

# Stage the edited file (skip for deletion-only runs — already staged above)
if [[ -n "$FILE_PATH" ]]; then
  git add -- "$FILE_PATH"
fi

# If we're in a merge state (conflict resolution from a previous hook run),
# complete the merge with the agent's resolved file.
if [[ -f "$GIT_DIR/MERGE_HEAD" ]]; then
  if [[ -n "$SESSION_ID" ]]; then
    git commit -m "auto(${SESSION_ID:0:8}): resolve merge conflict in $REL_PATH"
  else
    git commit -m "auto: resolve merge conflict in $REL_PATH"
  fi
else
  # Normal path: commit the edit
  if git diff --cached --quiet; then
    exit 0
  fi

  # Extract initial task from transcript (best-effort — never blocks the commit)
  TASK=""
  if [[ -n "$TRANSCRIPT_PATH" ]]; then
    EXPANDED_PATH="${TRANSCRIPT_PATH/#\~/$HOME}"
    if [[ -f "$EXPANDED_PATH" ]]; then
      TASK=$(set +o pipefail; jq -r '
        select(.type == "user")
        | .message
        | select(.role == "user")
        | .content
        | if type == "string" then .
          elif type == "array" then .[] | select(type == "string")
          else empty end
        | select(startswith("Stop hook feedback:") | not)
      ' "$EXPANDED_PATH" 2>/dev/null \
        | grep -v '^Implement the following plan:$' \
        | grep -v '^ *<' \
        | grep -v '^$' \
        | sed 's/^#\{1,\} //' \
        | head -1 | cut -c1-72) || true
    fi
  fi

  # Build subject line — use task description when available, fall back to action+path
  SESSION_PREFIX="${SESSION_ID:+auto(${SESSION_ID:0:8}): }"
  SESSION_PREFIX="${SESSION_PREFIX:-auto: }"

  if [[ -n "$TASK" ]]; then
    SUBJECT="${SESSION_PREFIX}${TASK}"
  else
    SUBJECT="${SESSION_PREFIX}${ACTION} ${REL_PATH}"
  fi

  # Build body (omit empty lines)
  BODY=""
  if [[ -n "$TASK" ]]; then
    BODY+="File: $REL_PATH"
  fi
  if [[ -n "$SESSION_ID" ]]; then
    [[ -n "$BODY" ]] && BODY+=$'\n'
    BODY+="Session: $SESSION_ID"
  fi
  if [[ -n "$TRANSCRIPT_PATH" ]]; then
    [[ -n "$BODY" ]] && BODY+=$'\n'
    BODY+="Transcript: $TRANSCRIPT_PATH"
  fi

  if [[ -n "$BODY" ]]; then
    git commit -m "$SUBJECT" -m "$BODY"
  else
    git commit -m "$SUBJECT"
  fi
fi

# Sync with other agents working on trunk.
# On failure, exit 2 sends the message to the coding agent as hook feedback.
# The agent doesn't know about this hook, so the error must be self-contained.

HOOK_EXPLAINER="A PostToolUse hook automatically commits and syncs every file change to keep multiple agents in sync on trunk."

conflict_exit() {
  cat >&2 <<HOOKFEEDBACK
TRUNK-SYNC CONFLICT: $HOOK_EXPLAINER Another agent changed the same file, creating a merge conflict. The file now contains git conflict markers (<<<<<<< / ======= / >>>>>>>).

git output:
$1

To resolve: just read the conflicting file and edit it to the correct content (remove the conflict markers). This hook will detect the merge state and complete the sync automatically.
HOOKFEEDBACK
  exit 2
}

push_exit() {
  cat >&2 <<HOOKFEEDBACK
TRUNK-SYNC FAILED: $HOOK_EXPLAINER The push to remote failed.

git output:
$1

To resolve: run "git pull origin $TARGET_BRANCH --no-rebase" then "git push origin HEAD:$TARGET_BRANCH". If there are conflicts, read the conflicting files and edit them to remove the conflict markers — the hook will complete the sync on your next edit.
HOOKFEEDBACK
  exit 2
}

OUTPUT=$(git pull origin "$TARGET_BRANCH" --no-rebase 2>&1) || conflict_exit "$OUTPUT"

# Merge local main into the worktree branch to pick up any local-only commits
# (e.g., user committed directly on main). No-op if we're already on main or
# if local main is behind origin/main. This ensures the push includes everything.
CURRENT_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || true)
if [[ -n "$CURRENT_BRANCH" && "$CURRENT_BRANCH" != "$TARGET_BRANCH" ]]; then
  OUTPUT=$(git merge "$TARGET_BRANCH" --no-edit 2>&1) || conflict_exit "$OUTPUT"
fi

# Push to the target branch, retrying once if another agent pushed between our pull and push.
OUTPUT=$(git push origin "HEAD:$TARGET_BRANCH" 2>&1) || {
  OUTPUT=$(git pull origin "$TARGET_BRANCH" --no-rebase 2>&1) || conflict_exit "$OUTPUT"
  OUTPUT=$(git push origin "HEAD:$TARGET_BRANCH" 2>&1) || push_exit "$OUTPUT"
}

# Keep local main in sync. After the push, origin/main includes all of local main's
# commits (we merged them above), so this is always a fast-forward.
# If main is not checked out anywhere, update the ref directly.
# If it is (e.g., the user's main working tree), fast-forward merge there.
git fetch origin "$TARGET_BRANCH:$TARGET_BRANCH" 2>/dev/null || {
  MAIN_WT=$(git worktree list --porcelain | awk -v b="refs/heads/$TARGET_BRANCH" \
    '/^worktree /{p=""} /^worktree /{p=substr($0,10)} $0 == "branch " b {print p}')
  if [[ -n "$MAIN_WT" ]]; then
    git -C "$MAIN_WT" merge --ff-only "origin/$TARGET_BRANCH" 2>/dev/null || true
  fi
}
