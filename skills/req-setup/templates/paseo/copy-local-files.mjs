#!/usr/bin/env node
// Written into the project by req-kit's /req-setup. Copies local files that are not committed
// (for example .env) from the checkout a new Paseo worktree was created from, the same way on
// macOS, Linux and Windows. Files that do not exist there, or already exist here, are skipped.
//
//   paseo.json: "worktree": { "setup": ["npm ci", "node scripts/paseo/copy-local-files.mjs .env"] }

import fs from "node:fs";
import path from "node:path";

const source = process.env.PASEO_SOURCE_CHECKOUT_PATH;
const files = process.argv.slice(2);
if (!source) {
  console.log("没有环境变量 PASEO_SOURCE_CHECKOUT_PATH（不是 Paseo 新建 worktree 时运行的），跳过。");
  process.exit(0);
}
for (const file of files) {
  const from = path.resolve(source, file);
  const to = path.resolve(process.cwd(), file);
  if (path.resolve(from) === path.resolve(to)) continue;
  if (!fs.existsSync(from)) {
    console.log(`跳过 ${file}：来源目录中没有`);
    continue;
  }
  if (fs.existsSync(to)) {
    console.log(`跳过 ${file}：这里已经有了`);
    continue;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  console.log(`已复制 ${file}`);
}
