// `req checklist <需求> [--no-open]` (1.14): the acceptance checklist in words, and the page where
// the requester ticks it (served by the review page's server).
import fs from "node:fs";
import path from "node:path";
import { buildChecklist, checklistText } from "./checklist.js";

async function main(argv: string[]): Promise<number> {
  const feature = argv.find((a) => !a.startsWith("--"));
  if (!feature || argv.includes("--help") || argv.includes("-h")) {
    console.log("用法：req checklist <需求> [--no-open] [--text]\n\n按需求说明的验收标准生成验收清单（流水线没验证、没通过的排在前面），在浏览器里逐条勾选，提交后写成 acceptance.md。--text 只在终端里列出清单。");
    return feature ? 0 : 2;
  }
  const { locate } = await import("./api.js");
  const { repo, featureDir } = locate(process.cwd(), feature);
  if (!fs.existsSync(path.join(repo, featureDir, "spec.md"))) {
    console.error(`${featureDir} 中没有 spec.md`);
    return 1;
  }
  const list = buildChecklist(path.join(repo, featureDir));
  let url: string | null = null;
  if (!argv.includes("--text")) {
    const { ensureReviewServer, keyOf, reviewUrl } = await import("./review.js");
    const key = keyOf(repo, featureDir);
    if (key) url = `${reviewUrl(await ensureReviewServer(), key)}check/`;
  }
  console.log(checklistText(list, url));
  if (url && !argv.includes("--no-open")) (await import("./review.js")).openBrowser(url);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: Error) => {
    console.error(error.message);
    process.exit(1);
  },
);
