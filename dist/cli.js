#!/usr/bin/env node
import { createRequire } from "node:module";
import { configCommand } from "./commands/config.js";
import { installCommand } from "./commands/install.js";
import { seanceCommand } from "./commands/seance.js";
const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const USAGE = `trunk-sync v${pkg.version}

Usage: trunk-sync <command> [options]

Commands:
  install   Install the trunk-sync Claude Code plugin
  seance    Find which Claude session wrote a line of code
  config    Read or write trunk-sync configuration

Options:
  --version  Show version
  -h, --help Show this help message`;
const command = process.argv[2];
if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    process.exit(0);
}
if (command === "--version") {
    console.log(pkg.version);
    process.exit(0);
}
const subArgs = process.argv.slice(3);
switch (command) {
    case "install":
        installCommand(subArgs);
        break;
    case "seance":
        seanceCommand(subArgs);
        break;
    case "config":
        configCommand(subArgs);
        break;
    default:
        console.error(`Unknown command: ${command}\n`);
        console.log(USAGE);
        process.exit(1);
}
