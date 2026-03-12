import { execSync } from "node:child_process";
import { getGitRoot, commandExists } from "../lib/git.js";

export function installCommand(args: string[]): void {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: trunk-sync install [--scope user|project]

Installs the trunk-sync Claude Code plugin.

Options:
  --scope <scope>  Installation scope: "project" (default) or "user"
                   project — active in this repo only (.claude/plugins.json)
                   user    — active in all repos (~/.claude/plugins.json)
  -h, --help       Show this help message`);
    return;
  }

  const scopeIdx = args.indexOf("--scope");
  const scope = scopeIdx !== -1 ? args[scopeIdx + 1] : "project";

  if (scope !== "project" && scope !== "user") {
    console.error(`Invalid scope: ${scope}. Must be "project" or "user".`);
    process.exit(1);
  }

  // Precondition checks (git repo and remote are soft warnings — trunk-sync
  // works without them, just with reduced functionality)
  if (!getGitRoot()) {
    console.warn(
      "Warning: not inside a git repository. trunk-sync needs git to auto-commit and sync."
    );
  } else {
    try {
      execSync("git remote get-url origin", { stdio: "ignore" });
    } catch {
      // No remote is fine — hook will commit locally and skip pushing
    }
  }

  if (!commandExists("jq")) {
    console.error("jq is required. Install: brew install jq / apt install jq");
    process.exit(1);
  }

  if (!commandExists("claude")) {
    console.error(
      "Claude Code CLI not found. Install: https://docs.anthropic.com/en/docs/claude-code"
    );
    process.exit(1);
  }

  // Add GitHub repo as a marketplace source
  console.log("Adding trunk-sync marketplace...");
  try {
    execSync(
      `claude plugin marketplace add elimydlarz/trunk-sync --scope ${scope}`,
      { stdio: "inherit" }
    );
  } catch {
    // May already be added — continue to install
  }

  // Install the plugin from the marketplace
  console.log(`Installing trunk-sync plugin (scope: ${scope})...`);
  try {
    execSync(`claude plugin install trunk-sync@susu-eng --scope ${scope}`, {
      stdio: "inherit",
    });
  } catch {
    console.error("Plugin installation failed.");
    process.exit(1);
  }

  console.log(`\ntrunk-sync installed successfully (scope: ${scope}).

Every file edit will now auto-commit and sync to the remote.
Works on main, on branches, or in worktrees (claude -w).`);
}
