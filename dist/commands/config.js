import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const DEFAULTS = {
    "commit-transcripts": "false",
};
const USAGE = `Usage: trunk-sync config                   Show all config
       trunk-sync config <key>               Get a value
       trunk-sync config <key>=<value>       Set a value
       trunk-sync config --unset <key>       Remove a key

Config file: ~/.trunk-sync (key=value format)`;
export function configPath() {
    return join(homedir(), ".trunk-sync");
}
export function readConfig() {
    const map = new Map();
    let content;
    try {
        content = readFileSync(configPath(), "utf-8");
    }
    catch {
        return map;
    }
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1)
            continue;
        map.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
    }
    return map;
}
export function writeConfig(map) {
    const lines = [];
    for (const [key, value] of map) {
        lines.push(`${key}=${value}`);
    }
    writeFileSync(configPath(), lines.join("\n") + "\n");
}
export function configCommand(args) {
    if (args.includes("--help") || args.includes("-h")) {
        console.log(USAGE);
        return;
    }
    const unsetIndex = args.indexOf("--unset");
    if (unsetIndex !== -1) {
        const key = args[unsetIndex + 1];
        if (!key) {
            console.error("Usage: trunk-sync config --unset <key>");
            process.exit(1);
        }
        const map = readConfig();
        if (!map.has(key)) {
            console.error(`Key not found: ${key}`);
            process.exit(1);
        }
        map.delete(key);
        writeConfig(map);
        console.log(`Unset ${key}`);
        return;
    }
    const positional = args.filter((a) => !a.startsWith("--"));
    if (positional.length === 0) {
        const map = readConfig();
        if (map.size === 0) {
            console.log("No config set. Config file: ~/.trunk-sync");
            return;
        }
        for (const [key, value] of map) {
            console.log(`${key}=${value}`);
        }
        return;
    }
    const arg = positional[0];
    const eq = arg.indexOf("=");
    if (eq === -1) {
        // Single key — read its value
        const map = readConfig();
        const value = map.get(arg) ?? DEFAULTS[arg];
        if (value === undefined) {
            console.error(`Unknown key: ${arg}`);
            process.exit(1);
        }
        console.log(value);
        return;
    }
    const key = arg.slice(0, eq);
    const value = arg.slice(eq + 1);
    const map = readConfig();
    map.set(key, value);
    writeConfig(map);
    console.log(`Set ${key}=${value}`);
}
