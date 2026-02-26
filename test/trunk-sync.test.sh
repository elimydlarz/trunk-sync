#!/bin/bash
set -euo pipefail

# Test suite for trunk-sync.sh PostToolUse hook.
# Uses git worktrees (not separate clones) to simulate multi-agent scenarios.
# Output: TAP (Test Anything Protocol)

HOOK="$(cd "$(dirname "$0")/../.claude/hooks" && pwd)/trunk-sync.sh"
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
  jq -n --arg msg "$message" '{type:"user", message:{role:"user", content:$msg}}' > "$path"
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

# 3. File outside repo → exit 0, no commit
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

# 12. Body includes File, Session, and Transcript lines
BODY=$(last_body "$WT_A")
assert_contains "$BODY" "File: seed.txt" "body contains File line when task in subject"
assert_contains "$BODY" "Session: sess1234" "body contains Session line"
assert_contains "$BODY" "Transcript: $TRANSCRIPT" "body contains Transcript line"

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

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "1..$TEST_NUM"
echo "$PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
