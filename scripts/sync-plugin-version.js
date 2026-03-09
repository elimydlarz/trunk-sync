import { readFileSync, writeFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const pluginPath = '.claude-plugin/plugin.json';
const plugin = JSON.parse(readFileSync(pluginPath, 'utf8'));
plugin.version = pkg.version;
writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + '\n');
