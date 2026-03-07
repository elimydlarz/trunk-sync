import { execSync } from "node:child_process";
import { getGitRoot, commandExists } from "../lib/git.js";

export function installCommand(args: string[]): void {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: trunk-sync install [--scope user|project]

Installs the trunk-sync Claude Code plugin.

Options:
  --scope <scope>  Installation scope: "project" (default) or "user"
  -h, --help       Show this help message`);
    return;
  }

  const scopeIdx = args.indexOf("--scope");
  const scope = scopeIdx !== -1 ? args[scopeIdx + 1] : "project";

  if (scope !== "project" && scope !== "user") {
    console.error(`Invalid scope: ${scope}. Must be "project" or "user".`);
    process.exit(1);
  }

  // Precondition checks
  if (!getGitRoot()) {
    console.error("Must be run inside a git repository.");
    process.exit(1);
  }

  try {
    execSync("git remote get-url origin", { stdio: "ignore" });
  } catch {
    console.error("No git remote found. Run: git remote add origin <url>");
    process.exit(1);
  }

  if (!commandExists("jq")) {
    console.error("jq is required. Install: brew install jq / apt install jq");
    process.exit(1);
  }

  if (!commandExists("claude")) {
    console.error("Claude Code CLI not found. Install: https://docs.anthropic.com/en/docs/claude-code");
    process.exit(1);
  }

  console.log(`Installing trunk-sync plugin (scope: ${scope})...`);
  try {
    execSync(`claude plugin install trunk-sync@trunk-sync --scope ${scope}`, {
      stdio: "inherit",
    });
  } catch {
    console.error("Plugin installation failed.");
    process.exit(1);
  }

  console.log(`\ntrunk-sync installed successfully!

Next steps:
  1. Launch agents in worktrees: claude -w
  2. Each agent's edits will auto-commit and push to origin/main`);
}
