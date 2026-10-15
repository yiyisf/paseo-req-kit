// `req index`: the machine's list of requirements (records.ts), for people.
//   req index                      what is recorded
//   req index --rebuild [<dir>...] record the requirements that have run in these repositories
//                                  (default: here) and in those already recorded
//   req index --prune              forget the requirements whose directory is gone

import path from "node:path";
import { apiIndex } from "./api.js";
import { indexDir, readIndex } from "./records.js";

const argv = process.argv.slice(2);
const prune = argv.includes("--prune");
const rebuildAt = argv.indexOf("--rebuild");
const dirs = rebuildAt < 0 ? [] : argv.slice(rebuildAt + 1).filter((a) => !a.startsWith("--"));
if (rebuildAt >= 0 && dirs.length === 0) dirs.push(process.cwd());

if (rebuildAt >= 0 || prune) {
  const r = apiIndex({ rebuild: dirs, prune });
  if (rebuildAt >= 0) console.log(`扫描了 ${r.scanned.length} 个仓库，登记 ${r.registered} 个运行过的需求。`);
  if (prune) console.log(`移除了 ${r.pruned} 个目录已不在的需求。`);
  console.log(`本机共记录 ${r.total} 个需求（${indexDir()}）。`);
} else {
  const entries = readIndex();
  if (entries.length === 0) {
    console.log("本机还没有记录任何需求。1.9 之前运行过的需求：在项目目录运行 req index --rebuild。");
  } else {
    console.log(`本机记录的需求（${entries.length} 个；查看进度用 req api list --all 或 Paseo 插件）：`);
    for (const e of entries) {
      console.log(`- ${e.project}：${path.basename(e.featureDir)}${e.present ? "" : "（目录已不在，req index --prune 可以移除）"}`);
      console.log(`  ${path.join(e.repo, e.featureDir)}`);
    }
  }
}
