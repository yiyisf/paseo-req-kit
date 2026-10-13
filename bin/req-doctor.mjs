#!/usr/bin/env node
// req-kit doctor: read-only health check. Same in bash, PowerShell and cmd:
//   node "<req-kit>/bin/req-doctor.mjs" [--repo <dir>] [--no-project] [--offline]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(kitRoot, "node_modules", "tsx", "dist", "cli.mjs");
if (!fs.existsSync(tsxCli)) {
  console.log(`✗ 依赖未安装：找不到 tsx`);
  console.log(`    修复：在 ${kitRoot} 中执行 npm install，然后运行 node install.mjs`);
  process.exit(1);
}
const result = spawnSync(process.execPath, [tsxCli, path.join(kitRoot, "engine", "src", "doctor.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: true,
});
process.exit(result.status ?? 1);
