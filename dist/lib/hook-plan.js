/**
 * Parse the raw JSON string from hook stdin into a typed HookInput.
 */
export function parseHookInput(json) {
    const raw = JSON.parse(json);
    return {
        tool_name: raw.tool_name ?? null,
        tool_input: raw.tool_input ?? {},
        session_id: raw.session_id ?? null,
        transcript_path: raw.transcript_path ?? null,
    };
}
/**
 * Pure decision logic: given parsed input and repo state, decide what to do.
 * No I/O, no git commands — only data in, plan out.
 */
export function planHook(input, state) {
    const filePath = input.tool_input.file_path ?? null;
    const sync = buildSyncPlan(state);
    // No file_path and no deleted files → nothing to do
    if (!filePath && state.deletedFiles.length === 0) {
        return { action: "skip" };
    }
    // File path provided but outside the repo → skip
    if (filePath && !state.insideRepo) {
        return { action: "skip" };
    }
    // File path provided but gitignored → skip
    if (filePath && state.gitignored) {
        return { action: "skip" };
    }
    // In merge state → complete the merge
    if (state.inMerge) {
        const relPath = filePath ? state.relPath : summarizeDeletions(state.deletedFiles);
        const sessionPrefix = buildSessionPrefix(input.session_id);
        const message = `${sessionPrefix}resolve merge conflict in ${relPath}`;
        const filesToStage = filePath ? [filePath] : [];
        return {
            action: "commit-merge",
            message,
            sync,
        };
    }
    // Normal commit path
    const commit = buildCommitPlan(input, state);
    return { action: "commit-and-sync", commit, sync };
}
function buildSyncPlan(state) {
    if (!state.hasRemote)
        return null;
    return {
        targetBranch: state.targetBranch,
        currentBranch: state.currentBranch,
    };
}
function buildCommitPlan(input, state) {
    const filePath = input.tool_input.file_path ?? null;
    const action = filePath
        ? (input.tool_name ?? "update").toLowerCase()
        : "delete";
    const relPath = filePath
        ? state.relPath
        : summarizeDeletions(state.deletedFiles);
    const filesToStage = filePath ? [filePath] : [];
    const filesToRemove = filePath ? [] : state.deletedFiles;
    const sessionPrefix = buildSessionPrefix(input.session_id);
    const subject = `${sessionPrefix}${action} ${relPath}`;
    const body = buildCommitBody(input, filePath ? relPath : null);
    return { filesToStage, filesToRemove, subject, body };
}
/**
 * Build a commit plan with a task-based subject (when transcript extraction succeeds).
 */
export function buildCommitPlanWithTask(input, state, task) {
    const base = buildCommitPlan(input, state);
    if (!task)
        return base;
    const filePath = input.tool_input.file_path ?? null;
    const relPath = filePath ? state.relPath : summarizeDeletions(state.deletedFiles);
    const sessionPrefix = buildSessionPrefix(input.session_id);
    const subject = `${sessionPrefix}${task}`;
    // When task is present, include File: line in body
    let body = `File: ${relPath}`;
    if (input.session_id)
        body += `\nSession: ${input.session_id}`;
    return { ...base, subject, body: body || null };
}
export function buildSessionPrefix(sessionId) {
    if (sessionId)
        return `auto(${sessionId.slice(0, 8)}): `;
    return "auto: ";
}
export function buildCommitBody(input, _relPath) {
    if (!input.session_id)
        return null;
    return `Session: ${input.session_id}`;
}
/**
 * Extract the first user message from a JSONL transcript.
 * Filters out hook feedback, plan headers, XML tags, and empty lines.
 * Returns first 72 chars or null.
 */
export function extractTaskFromTranscript(content) {
    const lines = content.split("\n");
    for (const line of lines) {
        if (!line.trim())
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (!isUserMessage(parsed))
            continue;
        const msg = parsed.message;
        const texts = extractTextContent(msg.content);
        for (const text of texts) {
            const candidate = filterTaskLine(text);
            if (candidate)
                return candidate.slice(0, 72);
        }
    }
    return null;
}
function isUserMessage(obj) {
    if (typeof obj !== "object" || obj === null)
        return false;
    const rec = obj;
    if (rec.type !== "user")
        return false;
    if (typeof rec.message !== "object" || rec.message === null)
        return false;
    const msg = rec.message;
    return msg.role === "user";
}
function extractTextContent(content) {
    if (typeof content === "string")
        return [content];
    if (Array.isArray(content)) {
        return content.filter((item) => typeof item === "string");
    }
    return [];
}
function filterTaskLine(text) {
    const lines = text.split("\n");
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        if (trimmed.startsWith("Stop hook feedback:"))
            return null;
        if (trimmed === "Implement the following plan:")
            continue;
        if (trimmed.startsWith("<"))
            continue;
        // Strip leading markdown headers
        const stripped = trimmed.replace(/^#{1,}\s+/, "");
        if (stripped)
            return stripped;
    }
    return null;
}
/**
 * Summarize a list of deleted files: "file.txt (+2 more)"
 */
export function summarizeDeletions(files) {
    if (files.length === 0)
        return "";
    const first = files[0];
    if (files.length === 1)
        return first;
    return `${first} (+${files.length - 1} more)`;
}
