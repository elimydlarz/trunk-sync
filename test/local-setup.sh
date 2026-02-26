#!/bin/bash
set -euo pipefail

# Sets up a dirty local main for manual testing with claude -w.
# Run from the repo root: bash test/local-setup.sh

REPO_ROOT=$(git rev-parse --show-toplevel)

# Commit a file directly on main (not pushed to origin)
echo "This was committed on local main but never pushed." > "$REPO_ROOT/test/local-only.txt"
git add "$REPO_ROOT/test/local-only.txt"
git commit -m "local-only: unpushed commit on main"

echo ""
echo "Done. Local main is now 1 commit ahead of origin/main."
echo ""
echo "Now run 'claude -w' and ask the agent to edit test/battlefield.txt."
echo "The hook should merge local main into the worktree, push everything"
echo "(including local-only.txt) to origin, and fast-forward local main."
echo ""
echo "To reset: bash test/local-cleanup.sh"
