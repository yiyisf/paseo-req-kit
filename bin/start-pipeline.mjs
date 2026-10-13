#!/usr/bin/env node
// Shell-independent launcher: works the same from bash, PowerShell and cmd, so any
// Paseo chat agent (Claude Code, Codex, ...) can run it with plain `node "<path>" ...`.
// Inside a Paseo chat it reads the chat's agent ID and working directory from the
// environment Paseo provides (PASEO_AGENT_ID, PASEO_AGENT_CWD).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(toolDir, "node_modules", "tsx", "dist", "cli.mjs");
if (!fs.existsSync(tsxCli)) {
  console.error(`未启动：找不到 tsx。请先在 ${toolDir} 中执行 npm install。`);
  process.exit(2);
}
const result = spawnSync(process.execPath, [tsxCli, path.join(toolDir, "engine", "src", "launch.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: true,
});
process.exit(result.status ?? 1);
