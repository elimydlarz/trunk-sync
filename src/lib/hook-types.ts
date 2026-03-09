/** Raw JSON from Claude's PostToolUse hook stdin */
export interface HookInput {
  tool_name: string | null;
  tool_input: { file_path?: string };
  session_id: string | null;
  transcript_path: string | null;
}

/** Git state gathered before planning */
export interface RepoState {
  repoRoot: string;
  gitDir: string;
  /** file_path relative to repoRoot, or null if no file_path */
  relPath: string | null;
  /** true when file_path is inside the repo */
  insideRepo: boolean;
  /** true when file_path is gitignored */
  gitignored: boolean;
  /** true when origin remote exists */
  hasRemote: boolean;
  /** default branch on origin (e.g. "main"), empty when no remote */
  targetBranch: string;
  /** current branch name */
  currentBranch: string;
  /** true when MERGE_HEAD exists */
  inMerge: boolean;
  /** true when staging area has changes */
  hasStagedChanges: boolean;
  /** tracked files that have been deleted from the working tree */
  deletedFiles: string[];
}

export interface SyncPlan {
  targetBranch: string;
  currentBranch: string;
}

export interface CommitPlan {
  filesToStage: string[];
  filesToRemove: string[];
  subject: string;
  body: string | null;
}

export type HookPlan =
  | { action: "skip" }
  | { action: "commit-and-sync"; commit: CommitPlan; sync: SyncPlan | null }
  | { action: "commit-merge"; message: string; sync: SyncPlan | null };

export const HOOK_EXPLAINER =
  "A PostToolUse hook automatically commits and syncs every file change to keep multiple agents in sync on trunk.";
