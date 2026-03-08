import { execSync, spawnSync } from "node:child_process";
import { join, dirname, relative, resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  parseFileRef,
  blame,
  getCommitBody,
  getCommitSubject,
  getCommitDate,
  getCommitTimestamp,
  extractSessionId,
  extractTranscriptPath,
  commandExists,
  shortSha,
  getGitRoot,
} from "../lib/git.js";

const USAGE = `Usage: trunk-sync seance <file:line> [--inspect]
       trunk-sync seance --list

Find which Claude session wrote a line of code and fork that session.

Arguments:
  <file:line>   File path and line number, e.g. src/main.ts:42

Options:
  --inspect     Show commit and session info without launching Claude
  --list        List all trunk-sync sessions found in git history
  -h, --help    Show this help message`;

function listSessions(): void {
  let output: string;
  try {
    output = execSync('git log --format="%H" --grep="^auto("', {
      encoding: "utf-8",
    }).trim();
  } catch {
    output = "";
  }

  if (!output) {
    console.log("No trunk-sync sessions found in git history.");
    return;
  }

  const shas = output.split("\n");
  const seen = new Map<string, { sha: string; subject: string; date: string }>();

  for (const sha of shas) {
    const body = getCommitBody(sha);
    const sessionId = extractSessionId(body);
    if (sessionId && !seen.has(sessionId)) {
      seen.set(sessionId, {
        sha,
        subject: getCommitSubject(sha),
        date: getCommitDate(sha),
      });
    }
  }

  if (seen.size === 0) {
    console.log("No trunk-sync sessions found in git history.");
    return;
  }

  console.log("SESSION_ID                            SUBJECT                                          DATE");
  console.log("─".repeat(100));
  for (const [sessionId, { subject, date }] of seen) {
    const truncSubject = subject.length > 48 ? subject.slice(0, 45) + "..." : subject;
    const shortDate = date.slice(0, 19);
    console.log(
      `${sessionId.padEnd(38)}${truncSubject.padEnd(50)}${shortDate}`
    );
  }
}

/**
 * Create a truncated copy of a session transcript, containing only messages
 * up to the given timestamp. Returns the path to the new transcript file,
 * or null if the transcript can't be found or truncated.
 */
/**
 * Derive the Claude project slug for a given directory path.
 * Claude uses the absolute path with "/" replaced by "-".
 */
function projectSlug(dirPath: string): string {
  return dirPath.replace(/\//g, "-");
}

function rewindTranscript(
  transcriptPath: string,
  commitTimestamp: string,
  worktreePath: string
): { path: string; id: string } | null {
  const expandedPath = transcriptPath.replace(/^~/, process.env.HOME || "~");
  if (!existsSync(expandedPath)) return null;

  const cutoff = new Date(commitTimestamp).getTime();
  const lines = readFileSync(expandedPath, "utf-8").split("\n").filter(Boolean);

  // Find the last line whose timestamp is <= the commit timestamp.
  // Include all lines up to and including that point.
  let cutIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]);
      const ts = obj.timestamp;
      if (ts && new Date(ts).getTime() <= cutoff) {
        cutIndex = i;
      }
    } catch {
      // Non-JSON lines (shouldn't happen) — include them if before cutoff
    }
  }

  if (cutIndex < 0) return null;

  const newId = randomUUID();
  // Write the rewound transcript into the project directory Claude will use
  // for the worktree, so --resume can find it by session ID.
  const home = process.env.HOME || "~";
  const projectDir = join(home, ".claude", "projects", projectSlug(worktreePath));
  mkdirSync(projectDir, { recursive: true });
  const newPath = join(projectDir, `${newId}.jsonl`);
  const truncated = lines.slice(0, cutIndex + 1).join("\n") + "\n";
  writeFileSync(newPath, truncated);

  return { path: newPath, id: newId };
}

function inspectOrLaunch(fileRef: string, inspect: boolean): void {
  const { file, line } = parseFileRef(fileRef);

  const sha = blame(file, line);
  if (/^0+$/.test(sha)) {
    console.error(`Line ${line} has uncommitted changes.`);
    process.exit(1);
  }

  const body = getCommitBody(sha);
  const sessionId = extractSessionId(body);
  const subject = getCommitSubject(sha);

  if (!sessionId) {
    console.error(`Commit ${shortSha(sha)} was not created by trunk-sync.`);
    process.exit(1);
  }

  if (inspect) {
    console.log(`Commit:   ${sha}`);
    console.log(`Subject:  ${subject}`);
    console.log(`Session:  ${sessionId}`);
    return;
  }

  if (!commandExists("claude")) {
    console.error("Claude Code CLI not found.");
    process.exit(1);
  }

  const root = getGitRoot();
  if (!root) {
    console.error("Not in a git repository.");
    process.exit(1);
  }

  const worktreePath = join(root, ".claude", "worktrees", `seance-${shortSha(sha)}`);

  try {
    execSync(`git worktree add --detach "${worktreePath}" "${sha}"`, { stdio: "pipe" });
  } catch {
    console.error(`Failed to create worktree at ${sha}.`);
    process.exit(1);
  }

  const relFile = relative(root, resolve(file));
  const prompt = `You wrote ${relFile}:${line} in commit ${shortSha(sha)}. Explain yourself!`;

  // Try to rewind the session transcript to the commit point
  const transcriptPath = extractTranscriptPath(body);
  const commitTimestamp = getCommitTimestamp(sha);
  const rewound = transcriptPath
    ? rewindTranscript(transcriptPath, commitTimestamp, worktreePath)
    : null;

  const resumeId = rewound?.id ?? sessionId;
  const needsFork = !rewound; // only fork if we couldn't rewind (falling back to full session)

  if (rewound) {
    console.log(`Rewound session to commit ${shortSha(sha)} (${commitTimestamp})`);
  }
  console.log(`Forking session ${sessionId} (from commit ${shortSha(sha)}: ${subject})`);
  console.log(`Worktree at ${worktreePath}`);

  const args = needsFork
    ? ["--resume", resumeId, "--fork-session", prompt]
    : ["--resume", resumeId, prompt];

  const result = spawnSync("claude", args, {
    stdio: "inherit",
    cwd: worktreePath,
  });

  // Clean up the rewound transcript file
  if (rewound) {
    try { unlinkSync(rewound.path); } catch { /* best-effort */ }
  }

  try {
    execSync(`git worktree remove "${worktreePath}"`, { stdio: "pipe" });
  } catch {
    console.error(`Note: worktree left at ${worktreePath} — remove with: git worktree remove "${worktreePath}"`);
  }

  process.exit(result.status ?? 1);
}

export function seanceCommand(args: string[]): void {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }

  if (args.includes("--list")) {
    listSessions();
    return;
  }

  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length === 0) {
    console.log(USAGE);
    return;
  }

  const inspect = args.includes("--inspect");
  inspectOrLaunch(positional[0], inspect);
}
