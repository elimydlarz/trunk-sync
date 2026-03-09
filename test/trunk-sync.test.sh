#!/bin/bash
set -euo pipefail

# Test suite for trunk-sync.sh PostToolUse hook.
# Uses git worktrees (not separate clones) to simulate multi-agent scenarios.
# Output: TAP (Test Anything Protocol)

HOOK="$(cd "$(dirname "$0")/../scripts" && pwd)/trunk-sync.sh"
PASS=0
FAIL=0
TEST_NUM=0

# ── Helpers ──────────────────────────────────────────────────────────────────

make_input() {
  local file_path="${1:-}" session_id="${2:-}" tool_name="${3:-Edit}" transcript_path="${4:-}"
  jq -n \
    --arg fp "$file_path" \
    --arg sid "$session_id" \
    --arg tn "$tool_name" \
    --arg tp "$transcript_path" \
    '{tool_input:{file_path:$fp}, session_id:$sid, tool_name:$tn, transcript_path:$tp}'
}

create_transcript() {
  local path="$1" message="$2"
  jq -cn --arg msg "$message" '{type:"user", message:{role:"user", content:$msg}}' > "$path"
}

run_hook() {
  local input="$1"
  HOOK_EXIT=0
  HOOK_STDERR=""
  local stderr_file="$TMPDIR_BASE/stderr"
  printf '%s' "$input" | bash "$HOOK" >/dev/null 2>"$stderr_file" || HOOK_EXIT=$?
  HOOK_STDERR=$(cat "$stderr_file")
}

assert_exit() {
  local expected="$1" label="$2"
  TEST_NUM=$((TEST_NUM + 1))
  if [[ "$HOOK_EXIT" -eq "$expected" ]]; then
    echo "ok $TEST_NUM - $label"
    PASS=$((PASS + 1))
  else
    echo "not ok $TEST_NUM - $label"
    echo "  # expected exit $expected, got $HOOK_EXIT"
    [[ -n "$HOOK_STDERR" ]] && echo "  # stderr: $(head -1 <<< "$HOOK_STDERR")"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  TEST_NUM=$((TEST_NUM + 1))
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "ok $TEST_NUM - $label"
    PASS=$((PASS + 1))
  else
    echo "not ok $TEST_NUM - $label"
    echo "  # expected to contain: $needle"
    echo "  # actual: $haystack"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  TEST_NUM=$((TEST_NUM + 1))
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "ok $TEST_NUM - $label"
    PASS=$((PASS + 1))
  else
    echo "not ok $TEST_NUM - $label"
    echo "  # expected NOT to contain: $needle"
    echo "  # actual: $haystack"
    FAIL=$((FAIL + 1))
  fi
}

assert_equals() {
  local expected="$1" actual="$2" label="$3"
  TEST_NUM=$((TEST_NUM + 1))
  if [[ "$expected" == "$actual" ]]; then
    echo "ok $TEST_NUM - $label"
    PASS=$((PASS + 1))
  else
    echo "not ok $TEST_NUM - $label"
    echo "  # expected: $expected"
    echo "  # actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

commit_count() {
  git -C "$1" rev-list --count HEAD
}

last_subject() {
  git -C "$1" log -1 --format='%s'
}

last_body() {
  git -C "$1" log -1 --format='%b'
}

# ── Setup ────────────────────────────────────────────────────────────────────

TMPDIR_BASE=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

setup_repos() {
  cd "$TMPDIR_BASE"
  rm -rf "$TMPDIR_BASE/remote.git" "$TMPDIR_BASE/project" "$TMPDIR_BASE/wt-a" "$TMPDIR_BASE/wt-b"

  # Bare "remote" repo
  REMOTE="$TMPDIR_BASE/remote.git"
  git init --bare "$REMOTE" -b main >/dev/null 2>&1

  # Main project clone (not where agents work — just the base repo)
  PROJECT="$TMPDIR_BASE/project"
  git clone "$REMOTE" "$PROJECT" >/dev/null 2>&1
  git -C "$PROJECT" config user.email "test@test.com"
  git -C "$PROJECT" config user.name "Test"

  # Seed commit so HEAD exists
  echo "seed" > "$PROJECT/seed.txt"
  git -C "$PROJECT" add seed.txt
  git -C "$PROJECT" commit -m "seed" >/dev/null 2>&1
  git -C "$PROJECT" push origin main >/dev/null 2>&1

  # Worktree A — agent A's isolated working directory
  WT_A="$TMPDIR_BASE/wt-a"
  git -C "$PROJECT" worktree add "$WT_A" -b trunk-sync/agent-a origin/main >/dev/null 2>&1
  git -C "$WT_A" config user.email "agent-a@test.com"
  git -C "$WT_A" config user.name "Agent A"

  # Worktree B — agent B's isolated working directory
  WT_B="$TMPDIR_BASE/wt-b"
  git -C "$PROJECT" worktree add "$WT_B" -b trunk-sync/agent-b origin/main >/dev/null 2>&1
  git -C "$WT_B" config user.email "agent-b@test.com"
  git -C "$WT_B" config user.name "Agent B"
}

setup_repos

# ── Tests ────────────────────────────────────────────────────────────────────

# --- Early exits ---

# 1. Empty file_path → exit 0, no commit
BEFORE=$(commit_count "$WT_A")
cd "$WT_A"
run_hook "$(make_input "" "" "Edit" "")"
assert_exit 0 "empty file_path exits 0"
AFTER=$(commit_count "$WT_A")
assert_equals "$BEFORE" "$AFTER" "empty file_path creates no commit"

# 2. Not in a git repo → exit 0
NOT_GIT="$TMPDIR_BASE/not-a-repo"
mkdir -p "$NOT_GIT"
echo "hello" > "$NOT_GIT/file.txt"
cd "$NOT_GIT"
run_hook "$(make_input "$NOT_GIT/file.txt" "" "Edit" "")"
assert_exit 0 "not in a git repo exits 0"

# 3. No remote → commits locally, exits 0, does not attempt push
NO_REMOTE="$TMPDIR_BASE/no-remote"
git init "$NO_REMOTE" -b main >/dev/null 2>&1
git -C "$NO_REMOTE" config user.email "test@test.com"
git -C "$NO_REMOTE" config user.name "Test"
echo "seed" > "$NO_REMOTE/seed.txt"
git -C "$NO_REMOTE" add seed.txt
git -C "$NO_REMOTE" commit -m "seed" >/dev/null 2>&1

echo "edited" > "$NO_REMOTE/seed.txt"
cd "$NO_REMOTE"
run_hook "$(make_input "$NO_REMOTE/seed.txt" "no-remote-sess" "Edit" "")"
assert_exit 0 "no remote exits 0"
SUBJECT=$(last_subject "$NO_REMOTE")
assert_contains "$SUBJECT" "auto(no-remot" "no remote still commits locally"
NR_COUNT=$(commit_count "$NO_REMOTE")
assert_equals "2" "$NR_COUNT" "no remote created exactly one new commit"

# 4. File outside repo → exit 0, no commit
OUTSIDE="$TMPDIR_BASE/outside.txt"
echo "outside" > "$OUTSIDE"
cd "$WT_A"
BEFORE=$(commit_count "$WT_A")
run_hook "$(make_input "$OUTSIDE" "" "Edit" "")"
assert_exit 0 "file outside repo exits 0"
AFTER=$(commit_count "$WT_A")
assert_equals "$BEFORE" "$AFTER" "file outside repo creates no commit"

# 4. Gitignored file → exit 0, no commit
echo "*.log" > "$WT_A/.gitignore"
cd "$WT_A"
git add .gitignore
git commit -m "add gitignore" >/dev/null 2>&1
git push origin HEAD:main >/dev/null 2>&1
echo "debug output" > "$WT_A/debug.log"
BEFORE=$(commit_count "$WT_A")
run_hook "$(make_input "$WT_A/debug.log" "" "Edit" "")"
assert_exit 0 "gitignored file exits 0"
AFTER=$(commit_count "$WT_A")
assert_equals "$BEFORE" "$AFTER" "gitignored file creates no commit"

# --- Merge conflict path ---

# 5. MERGE_HEAD present + all conflicts resolved → commit with merge message
setup_repos

# Agent A commits and pushes via the hook
echo "line from A" > "$WT_A/conflict.txt"
cd "$WT_A"
run_hook "$(make_input "$WT_A/conflict.txt" "" "Edit" "")"

# Agent B makes a conflicting change — first pull A's change, then diverge
git -C "$WT_B" pull origin main --no-rebase >/dev/null 2>&1
echo "line from B" > "$WT_B/conflict.txt"
cd "$WT_B"
git -C "$WT_B" add conflict.txt
git -C "$WT_B" commit -m "B's version" >/dev/null 2>&1
git -C "$WT_B" push origin HEAD:main >/dev/null 2>&1

# Now agent A edits the same file — pull will conflict
echo "A's updated line" > "$WT_A/conflict.txt"
cd "$WT_A"
git -C "$WT_A" add conflict.txt
git -C "$WT_A" commit -m "A updates" >/dev/null 2>&1
git -C "$WT_A" pull origin main --no-rebase >/dev/null 2>&1 || true

# Resolve the conflict
echo "resolved content" > "$WT_A/conflict.txt"
git -C "$WT_A" add conflict.txt

run_hook "$(make_input "$WT_A/conflict.txt" "abc12345session" "Edit" "")"
assert_exit 0 "merge conflict resolved exits 0"
SUBJECT=$(last_subject "$WT_A")
assert_contains "$SUBJECT" "resolve merge conflict" "merge commit subject contains resolve merge conflict"

# 6. MERGE_HEAD present + unresolved files remain → git commit refuses
setup_repos

# Agent A creates two files and pushes
echo "a1" > "$WT_A/file1.txt"
echo "a2" > "$WT_A/file2.txt"
cd "$WT_A"
git -C "$WT_A" add file1.txt file2.txt
git -C "$WT_A" commit -m "A's files" >/dev/null 2>&1
git -C "$WT_A" push origin HEAD:main >/dev/null 2>&1

# Agent B pulls, modifies both, pushes
git -C "$WT_B" pull origin main --no-rebase >/dev/null 2>&1
echo "b1" > "$WT_B/file1.txt"
echo "b2" > "$WT_B/file2.txt"
git -C "$WT_B" add file1.txt file2.txt
git -C "$WT_B" commit -m "B's files" >/dev/null 2>&1
git -C "$WT_B" push origin HEAD:main >/dev/null 2>&1

# Agent A diverges on both files
echo "a1-v2" > "$WT_A/file1.txt"
echo "a2-v2" > "$WT_A/file2.txt"
git -C "$WT_A" add file1.txt file2.txt
git -C "$WT_A" commit -m "A updates both" >/dev/null 2>&1
git -C "$WT_A" pull origin main --no-rebase >/dev/null 2>&1 || true

# Resolve only file1, leave file2 with markers
echo "resolved file1" > "$WT_A/file1.txt"
git -C "$WT_A" add file1.txt

cd "$WT_A"
run_hook "$(make_input "$WT_A/file1.txt" "" "Edit" "")"
assert_exit 128 "partial merge resolution exits 128 — git refuses commit with unresolved paths"

# --- Normal commit path ---

# 7. No changes → exit 0, no new commit
setup_repos
cd "$WT_A"
BEFORE=$(commit_count "$WT_A")
run_hook "$(make_input "$WT_A/seed.txt" "" "Edit" "")"
assert_exit 0 "no changes exits 0"
AFTER=$(commit_count "$WT_A")
assert_equals "$BEFORE" "$AFTER" "no changes creates no commit"

# 8. Commit with session_id → subject includes truncated session prefix
setup_repos
echo "modified" > "$WT_A/seed.txt"
cd "$WT_A"
run_hook "$(make_input "$WT_A/seed.txt" "abcdef1234567890" "Edit" "")"
assert_exit 0 "commit with session_id exits 0"
SUBJECT=$(last_subject "$WT_A")
assert_equals "auto(abcdef12): edit seed.txt" "$SUBJECT" "subject has session prefix and action"

# 9. Commit without session_id → subject has no parenthesized prefix
setup_repos
echo "modified" > "$WT_A/seed.txt"
cd "$WT_A"
run_hook "$(make_input "$WT_A/seed.txt" "" "Edit" "")"
assert_exit 0 "commit without session_id exits 0"
SUBJECT=$(last_subject "$WT_A")
assert_equals "auto: edit seed.txt" "$SUBJECT" "subject without session_id"

# 10. Tool name lowercased
setup_repos
echo "modified" > "$WT_A/seed.txt"
cd "$WT_A"
run_hook "$(make_input "$WT_A/seed.txt" "" "Write" "")"
SUBJECT=$(last_subject "$WT_A")
assert_contains "$SUBJECT" "write" "tool name lowercased in subject"

# 11. Transcript task goes into subject, File into body
setup_repos
TRANSCRIPT="$TMPDIR_BASE/transcript.jsonl"
create_transcript "$TRANSCRIPT" "Implement the login page"
echo "modified" > "$WT_A/seed.txt"
cd "$WT_A"
run_hook "$(make_input "$WT_A/seed.txt" "sess1234" "Edit" "$TRANSCRIPT")"
SUBJECT=$(last_subject "$WT_A")
assert_contains "$SUBJECT" "Implement the login page" "subject contains task from transcript"

# 12. Body includes File and Session lines (no Transcript — path is derived)
BODY=$(last_body "$WT_A")
assert_contains "$BODY" "File: seed.txt" "body contains File line when task in subject"
assert_contains "$BODY" "Session: sess1234" "body contains Session line"
assert_not_contains "$BODY" "Transcript:" "body does not contain Transcript line"

# 13. No File line when transcript missing — body has Session only, no blank lines
setup_repos
echo "modified" > "$WT_A/seed.txt"
cd "$WT_A"
run_hook "$(make_input "$WT_A/seed.txt" "sess5678" "Edit" "")"
BODY=$(last_body "$WT_A")
assert_contains "$BODY" "Session: sess5678" "body contains Session without transcript"
assert_not_contains "$BODY" "File:" "no File line when transcript missing"
FIRST_LINE=$(head -1 <<< "$BODY")
assert_equals "Session: sess5678" "$FIRST_LINE" "no blank lines before Session"

# --- Sync path (worktree-to-worktree via origin/main) ---

# 14. Clean sync — push to origin/main succeeds from worktree branch
setup_repos
echo "new content" > "$WT_A/seed.txt"
cd "$WT_A"
run_hook "$(make_input "$WT_A/seed.txt" "sync1234" "Edit" "")"
assert_exit 0 "clean sync exits 0"
REMOTE_COUNT=$(git -C "$REMOTE" rev-list --count main)
LOCAL_COUNT=$(commit_count "$WT_A")
assert_equals "$LOCAL_COUNT" "$REMOTE_COUNT" "commit reached remote"

# 15. Agent B's change is visible to agent A after sync
setup_repos
echo "B wrote this" > "$WT_B/new-file.txt"
cd "$WT_B"
run_hook "$(make_input "$WT_B/new-file.txt" "agent-b" "Write" "")"
assert_exit 0 "agent B sync exits 0"

# Agent A edits something — the pull should bring in B's file
echo "A edited seed" > "$WT_A/seed.txt"
cd "$WT_A"
run_hook "$(make_input "$WT_A/seed.txt" "agent-a" "Edit" "")"
assert_exit 0 "agent A sync exits 0"
# B's file should now exist in A's worktree
TEST_NUM=$((TEST_NUM + 1))
if [[ -f "$WT_A/new-file.txt" ]]; then
  echo "ok $TEST_NUM - agent B's file visible in agent A's worktree after sync"
  PASS=$((PASS + 1))
else
  echo "not ok $TEST_NUM - agent B's file visible in agent A's worktree after sync"
  FAIL=$((FAIL + 1))
fi

# 16. Pull conflict — both agents modify same file
setup_repos
# Agent B writes and syncs first
echo "B was here" > "$WT_B/seed.txt"
cd "$WT_B"
run_hook "$(make_input "$WT_B/seed.txt" "" "Edit" "")"

# Agent A modifies same file (will conflict on pull)
echo "A was here" > "$WT_A/seed.txt"
cd "$WT_A"
run_hook "$(make_input "$WT_A/seed.txt" "" "Edit" "")"
assert_exit 2 "pull conflict exits 2"
assert_contains "$HOOK_STDERR" "TRUNK-SYNC CONFLICT" "stderr contains TRUNK-SYNC CONFLICT"

# 17. Push retry — agents modify different files, push fails then retries
setup_repos
# Agent B pushes a different file
echo "B's file" > "$WT_B/other.txt"
cd "$WT_B"
run_hook "$(make_input "$WT_B/other.txt" "" "Edit" "")"

# Agent A modifies a different file — push fails (behind), pull merges cleanly, retry succeeds
echo "A modifies seed" > "$WT_A/seed.txt"
cd "$WT_A"
run_hook "$(make_input "$WT_A/seed.txt" "" "Edit" "")"
assert_exit 0 "push retry succeeds after non-conflicting pull"
REMOTE_LOG=$(git -C "$REMOTE" log --oneline main)
assert_contains "$REMOTE_LOG" "auto:" "remote has agent commits"

# 18. Both worktrees converge — after sync, both have the same files
CONTENT_A=$(cat "$WT_A/other.txt")
assert_equals "B's file" "$CONTENT_A" "agent A has agent B's file content after sync"

# --- Local main sync ---

# 19. Local main is fast-forwarded after worktree push
setup_repos
echo "from worktree" > "$WT_A/seed.txt"
cd "$WT_A"
run_hook "$(make_input "$WT_A/seed.txt" "" "Edit" "")"
assert_exit 0 "worktree push exits 0"
# PROJECT has main checked out — hook should have fast-forwarded it
PROJECT_CONTENT=$(cat "$PROJECT/seed.txt")
assert_equals "from worktree" "$PROJECT_CONTENT" "local main working tree updated after worktree push"

# 20. Local main tracks multiple agents — B pushes, main updates, A pushes, main updates again
setup_repos
echo "B first" > "$WT_B/seed.txt"
cd "$WT_B"
run_hook "$(make_input "$WT_B/seed.txt" "" "Edit" "")"
PROJECT_CONTENT=$(cat "$PROJECT/seed.txt")
assert_equals "B first" "$PROJECT_CONTENT" "local main has B's content"

echo "A second" > "$WT_A/newfile.txt"
cd "$WT_A"
run_hook "$(make_input "$WT_A/newfile.txt" "" "Write" "")"
TEST_NUM=$((TEST_NUM + 1))
if [[ -f "$PROJECT/newfile.txt" ]]; then
  echo "ok $TEST_NUM - local main has A's new file after A pushes"
  PASS=$((PASS + 1))
else
  echo "not ok $TEST_NUM - local main has A's new file after A pushes"
  FAIL=$((FAIL + 1))
fi

# 21. Local commits on main are incorporated — user commits on main, agent picks them up
setup_repos
# User commits directly on main in the project
echo "user's local work" > "$PROJECT/user-file.txt"
git -C "$PROJECT" add user-file.txt
git -C "$PROJECT" commit -m "user commit on main" >/dev/null 2>&1
# This commit is NOT on origin — only on local main

# Agent edits in worktree — the hook should merge local main, push everything
echo "agent work" > "$WT_A/agent-file.txt"
cd "$WT_A"
run_hook "$(make_input "$WT_A/agent-file.txt" "" "Write" "")"
assert_exit 0 "agent push exits 0 with local-only commits on main"

# User's file should now be on origin (the hook pushed it along)
REMOTE_FILES=$(git -C "$REMOTE" ls-tree --name-only -r main)
assert_contains "$REMOTE_FILES" "user-file.txt" "user's local commit reached origin via agent push"

# Local main should be up to date (ff worked because we merged main before pushing)
PROJECT_FILES=$(ls "$PROJECT")
assert_contains "$PROJECT_FILES" "agent-file.txt" "local main has agent's file after sync"

# --- File deletion sync ---

# 22. Single file deletion — Bash with no file_path stages and commits the deletion
setup_repos
echo "to be deleted" > "$WT_A/doomed.txt"
cd "$WT_A"
run_hook "$(make_input "$WT_A/doomed.txt" "" "Write" "")"
assert_exit 0 "create file for deletion test"

# Delete the file (simulating agent running rm via Bash)
rm "$WT_A/doomed.txt"
BEFORE=$(commit_count "$WT_A")
run_hook "$(make_input "" "del-sess1" "Bash" "")"
assert_exit 0 "deletion sync exits 0"
AFTER=$(commit_count "$WT_A")
TEST_NUM=$((TEST_NUM + 1))
if [[ "$AFTER" -gt "$BEFORE" ]]; then
  echo "ok $TEST_NUM - deletion created a commit"
  PASS=$((PASS + 1))
else
  echo "not ok $TEST_NUM - deletion created a commit"
  FAIL=$((FAIL + 1))
fi
SUBJECT=$(last_subject "$WT_A")
assert_contains "$SUBJECT" "delete" "deletion commit subject contains delete"
assert_contains "$SUBJECT" "doomed.txt" "deletion commit subject contains filename"

# File should be gone from remote too
REMOTE_FILES=$(git -C "$REMOTE" ls-tree --name-only -r main)
assert_not_contains "$REMOTE_FILES" "doomed.txt" "deleted file removed from remote"

# 23. Multiple file deletion — commit message summarizes count
setup_repos
echo "a" > "$WT_A/del1.txt"
echo "b" > "$WT_A/del2.txt"
echo "c" > "$WT_A/del3.txt"
cd "$WT_A"
git -C "$WT_A" add del1.txt del2.txt del3.txt
git -C "$WT_A" commit -m "add files to delete" >/dev/null 2>&1
git -C "$WT_A" push origin HEAD:main >/dev/null 2>&1

rm "$WT_A/del1.txt" "$WT_A/del2.txt" "$WT_A/del3.txt"
run_hook "$(make_input "" "" "Bash" "")"
assert_exit 0 "multi-deletion sync exits 0"
SUBJECT=$(last_subject "$WT_A")
assert_contains "$SUBJECT" "delete" "multi-deletion subject contains delete"
assert_contains "$SUBJECT" "+2 more" "multi-deletion subject shows count of additional files"

# 24. No deletions — Bash with no file_path and no deleted files exits 0, no commit
setup_repos
cd "$WT_A"
BEFORE=$(commit_count "$WT_A")
run_hook "$(make_input "" "" "Bash" "")"
assert_exit 0 "no deletions exits 0"
AFTER=$(commit_count "$WT_A")
assert_equals "$BEFORE" "$AFTER" "no deletions creates no commit"

# 25. Deletion syncs to other agent — agent B sees file removed after sync
setup_repos
echo "shared file" > "$WT_A/shared.txt"
cd "$WT_A"
run_hook "$(make_input "$WT_A/shared.txt" "" "Write" "")"

# Agent B pulls to get the file
cd "$WT_B"
echo "trigger" > "$WT_B/trigger.txt"
run_hook "$(make_input "$WT_B/trigger.txt" "" "Write" "")"
TEST_NUM=$((TEST_NUM + 1))
if [[ -f "$WT_B/shared.txt" ]]; then
  echo "ok $TEST_NUM - agent B has shared file before deletion"
  PASS=$((PASS + 1))
else
  echo "not ok $TEST_NUM - agent B has shared file before deletion"
  FAIL=$((FAIL + 1))
fi

# Agent A deletes it
rm "$WT_A/shared.txt"
cd "$WT_A"
run_hook "$(make_input "" "" "Bash" "")"
assert_exit 0 "deletion by A exits 0"

# Agent B edits something — pull should bring in the deletion
echo "more work" > "$WT_B/trigger.txt"
cd "$WT_B"
run_hook "$(make_input "$WT_B/trigger.txt" "" "Edit" "")"
TEST_NUM=$((TEST_NUM + 1))
if [[ ! -f "$WT_B/shared.txt" ]]; then
  echo "ok $TEST_NUM - agent B no longer has deleted file after sync"
  PASS=$((PASS + 1))
else
  echo "not ok $TEST_NUM - agent B no longer has deleted file after sync"
  FAIL=$((FAIL + 1))
fi

# --- Concurrent push race ---

# 26. Concurrent push — two worktrees push different files simultaneously,
#     at least one needs to retry; both succeed
setup_repos

# Agent A and B each create different files
echo "A's content" > "$WT_A/a-file.txt"
echo "B's content" > "$WT_B/b-file.txt"

# Run both hooks concurrently — they race to push to origin/main
cd "$WT_A"
HOOK_EXIT_A=0
STDERR_A=""
STDERR_FILE_A="$TMPDIR_BASE/stderr-race-a"
(printf '%s' "$(make_input "$WT_A/a-file.txt" "race-a" "Write" "")" | bash "$HOOK" >/dev/null 2>"$STDERR_FILE_A") &
PID_A=$!

cd "$WT_B"
HOOK_EXIT_B=0
STDERR_B=""
STDERR_FILE_B="$TMPDIR_BASE/stderr-race-b"
(printf '%s' "$(make_input "$WT_B/b-file.txt" "race-b" "Write" "")" | bash "$HOOK" >/dev/null 2>"$STDERR_FILE_B") &
PID_B=$!

wait $PID_A || HOOK_EXIT_A=$?
wait $PID_B || HOOK_EXIT_B=$?
STDERR_A=$(cat "$STDERR_FILE_A")
STDERR_B=$(cat "$STDERR_FILE_B")

# Both must succeed (push retry handles the race)
TEST_NUM=$((TEST_NUM + 1))
if [[ "$HOOK_EXIT_A" -eq 0 && "$HOOK_EXIT_B" -eq 0 ]]; then
  echo "ok $TEST_NUM - concurrent push: both agents succeed"
  PASS=$((PASS + 1))
else
  echo "not ok $TEST_NUM - concurrent push: both agents succeed"
  echo "  # agent A exit=$HOOK_EXIT_A, agent B exit=$HOOK_EXIT_B"
  [[ -n "$STDERR_A" ]] && echo "  # agent A stderr: $(head -1 <<< "$STDERR_A")"
  [[ -n "$STDERR_B" ]] && echo "  # agent B stderr: $(head -1 <<< "$STDERR_B")"
  FAIL=$((FAIL + 1))
fi

# Both files should be on the remote
REMOTE_FILES=$(git -C "$REMOTE" ls-tree --name-only -r main)
assert_contains "$REMOTE_FILES" "a-file.txt" "concurrent push: agent A's file on remote"
assert_contains "$REMOTE_FILES" "b-file.txt" "concurrent push: agent B's file on remote"

# The agent that retried will have pulled the other's file.
# The first-pusher won't have the other's file yet (no pull after its own push).
# Verify at least one worktree has the other's file (the retrier).
TEST_NUM=$((TEST_NUM + 1))
if [[ -f "$WT_A/b-file.txt" ]] || [[ -f "$WT_B/a-file.txt" ]]; then
  echo "ok $TEST_NUM - concurrent push: retrier pulled the other agent's file"
  PASS=$((PASS + 1))
else
  echo "not ok $TEST_NUM - concurrent push: retrier pulled the other agent's file"
  echo "  # WT_A has b-file.txt: $(test -f "$WT_A/b-file.txt" && echo yes || echo no)"
  echo "  # WT_B has a-file.txt: $(test -f "$WT_B/a-file.txt" && echo yes || echo no)"
  FAIL=$((FAIL + 1))
fi

# 27. Concurrent push conflict — two worktrees edit the same file simultaneously,
#     one succeeds, the other gets a conflict (exit 2)
setup_repos

echo "A's version" > "$WT_A/seed.txt"
echo "B's version" > "$WT_B/seed.txt"

cd "$WT_A"
HOOK_EXIT_A=0
STDERR_FILE_A="$TMPDIR_BASE/stderr-conflict-a"
(printf '%s' "$(make_input "$WT_A/seed.txt" "conf-a" "Edit" "")" | bash "$HOOK" >/dev/null 2>"$STDERR_FILE_A") &
PID_A=$!

cd "$WT_B"
HOOK_EXIT_B=0
STDERR_FILE_B="$TMPDIR_BASE/stderr-conflict-b"
(printf '%s' "$(make_input "$WT_B/seed.txt" "conf-b" "Edit" "")" | bash "$HOOK" >/dev/null 2>"$STDERR_FILE_B") &
PID_B=$!

wait $PID_A || HOOK_EXIT_A=$?
wait $PID_B || HOOK_EXIT_B=$?
STDERR_A=$(cat "$STDERR_FILE_A")
STDERR_B=$(cat "$STDERR_FILE_B")

# Exactly one should succeed (0) and one should conflict (2)
TEST_NUM=$((TEST_NUM + 1))
EXITS_SORTED=$(printf '%s\n%s' "$HOOK_EXIT_A" "$HOOK_EXIT_B" | sort -n | tr '\n' ',')
if [[ "$EXITS_SORTED" == "0,2," ]]; then
  echo "ok $TEST_NUM - concurrent conflict: one succeeds, one conflicts"
  PASS=$((PASS + 1))
else
  echo "not ok $TEST_NUM - concurrent conflict: one succeeds, one conflicts"
  echo "  # exits: A=$HOOK_EXIT_A B=$HOOK_EXIT_B (expected one 0, one 2)"
  FAIL=$((FAIL + 1))
fi

# The failing agent should get TRUNK-SYNC CONFLICT feedback
CONFLICT_STDERR=""
if [[ "$HOOK_EXIT_A" -eq 2 ]]; then CONFLICT_STDERR="$STDERR_A"; fi
if [[ "$HOOK_EXIT_B" -eq 2 ]]; then CONFLICT_STDERR="$STDERR_B"; fi
assert_contains "$CONFLICT_STDERR" "TRUNK-SYNC CONFLICT" "concurrent conflict: loser gets conflict message"

# --- Transcript snapshots ---

# 28. Default: no .transcripts/ created
setup_repos
echo "no snapshot" > "$WT_A/seed.txt"
TRANSCRIPT="$TMPDIR_BASE/transcript-nosnapshot.jsonl"
create_transcript "$TRANSCRIPT" "No snapshot task"
cd "$WT_A"
run_hook "$(make_input "$WT_A/seed.txt" "nosn1234" "Edit" "$TRANSCRIPT")"
assert_exit 0 "default: commit succeeds without snapshot"
REMOTE_FILES=$(git -C "$REMOTE" ls-tree --name-only -r main)
assert_not_contains "$REMOTE_FILES" ".transcripts" "default: no .transcripts/ created"

# 29. Enabled: snapshot in same commit as code change
setup_repos
echo "commit-transcripts=true" > "$HOME/.trunk-sync"
TRANSCRIPT="$TMPDIR_BASE/transcript-snap.jsonl"
create_transcript "$TRANSCRIPT" "Snapshot task"
echo "with snapshot" > "$WT_A/seed.txt"
cd "$WT_A"
run_hook "$(make_input "$WT_A/seed.txt" "snap1234" "Edit" "$TRANSCRIPT")"
assert_exit 0 "snapshot: commit succeeds"

# Verify snapshot is in the same commit as the code change
LAST_SHA=$(git -C "$WT_A" rev-parse HEAD)
SNAPSHOT_FILES=$(git -C "$WT_A" diff-tree --no-commit-id --name-only -r "$LAST_SHA" -- .transcripts/)
TEST_NUM=$((TEST_NUM + 1))
if [[ -n "$SNAPSHOT_FILES" ]]; then
  echo "ok $TEST_NUM - snapshot: .transcripts/ file in same commit as code change"
  PASS=$((PASS + 1))
else
  echo "not ok $TEST_NUM - snapshot: .transcripts/ file in same commit as code change"
  FAIL=$((FAIL + 1))
fi
assert_contains "$SNAPSHOT_FILES" "snap1234" "snapshot: filename contains session short ID"

# 30. Enabled but no transcript_path: graceful no-op
setup_repos
echo "commit-transcripts=true" > "$HOME/.trunk-sync"
echo "no transcript path" > "$WT_A/seed.txt"
cd "$WT_A"
run_hook "$(make_input "$WT_A/seed.txt" "notp1234" "Edit" "")"
assert_exit 0 "snapshot with no transcript_path: exits 0"
LAST_SHA=$(git -C "$WT_A" rev-parse HEAD)
SNAPSHOT_FILES=$(git -C "$WT_A" diff-tree --no-commit-id --name-only -r "$LAST_SHA" -- .transcripts/)
assert_equals "" "$SNAPSHOT_FILES" "snapshot with no transcript_path: no .transcripts/ created"

# Clean up config
rm -f "$HOME/.trunk-sync"

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "1..$TEST_NUM"
echo "$PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
