import { readFileSync } from "node:fs";
import { parseHookInput, planHook } from "./hook-plan.js";
import { gatherRepoState, executePlan } from "./hook-execute.js";
function main() {
    let rawInput = "";
    try {
        rawInput = readFileSync(0, "utf-8");
    }
    catch {
        // no stdin
    }
    const input = parseHookInput(rawInput || "{}");
    const state = gatherRepoState(input);
    // Not in a git repo — no-op
    if (!state)
        process.exit(0);
    const plan = planHook(input, state);
    const result = executePlan(plan, input, state);
    if (result.stderr) {
        process.stderr.write(result.stderr + "\n");
    }
    process.exit(result.exitCode);
}
main();
