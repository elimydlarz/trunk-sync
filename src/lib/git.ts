import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

export function getGitRoot(): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

export function parseFileRef(ref: string): { file: string; line: number } {
  const lastColon = ref.lastIndexOf(":");
  if (lastColon === -1) {
    throw new Error(`Expected file:line, e.g. src/main.ts:42`);
  }
  const file = ref.slice(0, lastColon);
  const lineStr = ref.slice(lastColon + 1);
  const line = Number(lineStr);
  if (!Number.isInteger(line) || line < 1) {
    throw new Error(`Expected file:line with a positive integer line number, got: ${ref}`);
  }
  if (!existsSync(file)) {
    throw new Error(`File not found: ${file}`);
  }
  return { file, line };
}

export function blame(file: string, line: number, cwd?: string): string {
  const output = execSync(`git blame "${file}" -L ${line},${line} --porcelain`, {
    encoding: "utf-8",
    cwd,
  });
  const sha = output.split("\n")[0].split(" ")[0];
  return sha;
}

export function getCommitBody(sha: string, cwd?: string): string {
  return execSync(`git log -1 --format=%b "${sha}"`, { encoding: "utf-8", cwd }).trim();
}

export function getCommitSubject(sha: string, cwd?: string): string {
  return execSync(`git log -1 --format=%s "${sha}"`, { encoding: "utf-8", cwd }).trim();
}

export function getCommitDate(sha: string, cwd?: string): string {
  return execSync(`git log -1 --format=%ci "${sha}"`, { encoding: "utf-8", cwd }).trim();
}

export function extractSessionId(body: string): string | null {
  const match = body.match(/^Session:\s*(.+)/m);
  return match ? match[1].trim() : null;
}

export function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v "${cmd}"`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}
