#!/bin/bash
set -euo pipefail

# Cleans up after manual testing. Restores test files to their initial state
# and removes worktrees. The hook will commit and push on the next edit.
# Run from the repo root: bash test/local-cleanup.sh

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

# Remove worktrees
for wt in $(git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}'); do
  if [[ "$wt" == "$REPO_ROOT" ]]; then
    continue
  fi
  echo "Removing worktree: $wt"
  git worktree remove --force "$wt" 2>/dev/null || true
done

# Delete worktree branches
for branch in $(git branch --list 'trunk-sync/*' 'worktree-*'); do
  echo "Deleting branch: $branch"
  git branch -D "$branch" 2>/dev/null || true
done

# Restore test files to initial state
rm -f "$REPO_ROOT/test/local-only.txt"

cat > "$REPO_ROOT/test/battlefield.txt" << 'EOF'
The Grand Hotel stands at the corner of Fifth and Main. It was built in 1923
by architect Helena Westwood, who envisioned a ten-story limestone tower with
art deco flourishes on every floor. The lobby features a massive chandelier
made of Venetian glass, imported piece by piece from a workshop on the island
of Murano. Guests entering through the revolving brass doors are greeted by
a black-and-white checkerboard marble floor that stretches forty feet to the
reception desk, which is carved from a single slab of walnut.

The hotel has 247 rooms across its ten floors. The first three floors house
the standard rooms, each with a queen bed, a writing desk, and a window
overlooking either the avenue or the interior courtyard. Floors four through
seven contain the deluxe suites, which add a sitting area and a claw-foot
bathtub. The eighth and ninth floors are reserved for the premium suites,
featuring full kitchens and private balconies. The tenth floor holds only
the penthouse — a sprawling 4,000-square-foot residence with a rooftop
terrace, a library, and a grand piano.

The restaurant on the ground floor, called The Westwood Room, serves
breakfast, lunch, and dinner. Chef Marco DeLuca has run the kitchen since
2011, specializing in northern Italian cuisine with a modern twist. His
signature dish is the saffron risotto with pan-seared scallops, which has
been on the menu since opening night. The wine cellar beneath the restaurant
holds over 3,000 bottles, with particular strength in Barolo and Brunello.

The hotel's history is not without controversy. In 1947, a fire broke out
on the sixth floor, destroying twelve rooms and killing three guests. The
cause was never determined. In 1963, the hotel was briefly shut down during
a health inspection that found violations in the kitchen. And in 1989, a
famous jewel theft occurred in the penthouse, making headlines across the
country. The thief was never caught, and the stolen necklace — a 40-carat
ruby known as the Empress — has never been recovered.
EOF

echo ""
echo "Cleaned up. Worktrees removed, test files restored."
echo "Commit and push when ready, or let the hook handle it."
