import { execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import {
  parseFileRef,
  blame,
  getCommitBody,
  getCommitSubject,
  getCommitDate,
  getCommitTimestamp,
  extractSessionId,
  findSnapshotInCommit,
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
 * Derive the Claude project slug for a given directory path.
 * Claude replaces "/" and "." with "-" in the absolute path.
 */
function projectSlug(dirPath: string): string {
  return dirPath.replace(/[/.]/g, "-");
}

/**
 * Create a truncated copy of a session transcript, containing only messages
 * up to the given timestamp. The copy is written into the worktree's project
 * directory so Claude can find it via --resume.
 */
function rewindTranscript(
  transcriptPath: string,
  commitTimestamp: string,
  worktreePath: string
): { path: string; id: string } | null {
  const expandedPath = transcriptPath.replace(/^~/, process.env.HOME || "~");
  if (!existsSync(expandedPath)) return null;

  // Git timestamps have second precision; transcript timestamps have millisecond
  // precision. Adding 999ms includes the full second of the commit so we don't
  // cut off transcript entries that fall within the same second as the commit.
  const cutoff = new Date(commitTimestamp).getTime() + 999;
  const lines = readFileSync(expandedPath, "utf-8").split("\n").filter(Boolean);

  // Find the last line whose timestamp is <= the commit timestamp.
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
  // Write into the project directory Claude will use for the worktree.
  const home = process.env.HOME || "~";
  const projectDir = join(home, ".claude", "projects", projectSlug(worktreePath));
  mkdirSync(projectDir, { recursive: true });
  const newPath = join(projectDir, `${newId}.jsonl`);
  // Rewrite sessionId and cwd so Claude recognises this as a valid session.
  const rewritten = lines.slice(0, cutIndex + 1).map((line) => {
    try {
      const obj = JSON.parse(line);
      if (obj.sessionId) obj.sessionId = newId;
      if (obj.cwd) obj.cwd = worktreePath;
      return JSON.stringify(obj);
    } catch {
      return line;
    }
  });
  writeFileSync(newPath, rewritten.join("\n") + "\n");

  return { path: newPath, id: newId };
}

function inspectOrLaunch(fileRef: string, inspect: boolean): void {
  const { file, line } = parseFileRef(fileRef);

  const blameResult = blame(file, line);
  const sha = blameResult.sha;
  const origLine = blameResult.origLine;
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
  const prompt = `*STOP*. *HALT ALL PREVIOUS OPERATIONS AND STOP IMMEDIATELY*. *DO NOT CONTINUE YOUR CURRENT CHAIN OF THOUGHT*. This session already ended. It has been resumed and rewound — including the code — so you can answer questions about why it was written this way. *DO NOT* change any code. Start by explaining ${relFile}:${origLine} (commit ${shortSha(sha)}) — what does it do, how does it work, and why is it written this way?`;

  // Rewind the session transcript to the commit point.
  // Try snapshot from .transcripts/ in the commit first, fall back to Transcript: field.
  const snapshotRelPath = findSnapshotInCommit(sha);
  let transcriptSource: string | null = null;
  if (snapshotRelPath) {
    const snapshotAbsPath = join(root, snapshotRelPath);
    if (existsSync(snapshotAbsPath)) {
      transcriptSource = snapshotAbsPath;
    }
  }
  if (!transcriptSource) {
    const home = process.env.HOME || "~";
    const derived = join(home, ".claude", "projects", projectSlug(root), `${sessionId}.jsonl`);
    if (existsSync(derived)) {
      transcriptSource = derived;
    }
  }
  if (!transcriptSource) {
    console.error(`Commit ${shortSha(sha)} has no transcript (no .transcripts/ snapshot and no transcript at derived path).`);
    process.exit(1);
  }
  const commitTimestamp = getCommitTimestamp(sha);
  const rewound = rewindTranscript(transcriptSource, commitTimestamp, worktreePath);
  if (!rewound) {
    console.error(`Could not rewind transcript for commit ${shortSha(sha)}.`);
    process.exit(1);
  }

  console.log(`Rewound session to commit ${shortSha(sha)} (${commitTimestamp})`);
  console.log(`Forking session ${sessionId} (from commit ${shortSha(sha)}: ${subject})`);
  console.log(`Worktree at ${worktreePath}`);

  const readOnlyTools = "Read,Grep,Glob,Bash(git:*),Agent,WebSearch,WebFetch";
  const systemPrompt =
    "You are in SEANCE MODE — a read-only forensic session. You MUST NOT edit, write, or create any files. " +
    "Your only job is to explain the code: what it does, how it works, and why it was written this way. " +
    "You do not have access to Edit, Write, or NotebookEdit tools.";

  const args = [
    "--resume", rewound.id,
    "--allowedTools", readOnlyTools,
    "--append-system-prompt", systemPrompt,
    prompt,
  ];

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
