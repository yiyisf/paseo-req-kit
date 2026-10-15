// Copies the repository's own documents into the site (docs/guide, contracts, docs/adr,
// SCOPE.md, CHANGELOG.md) under English paths, rewriting their relative links: links to
// another copied document become site links, links to anything else go to GitHub.
// The copies are generated (see .gitignore); edit the originals.
//
//   node scripts/sync-docs.mjs          write the copies
//   node scripts/sync-docs.mjs --check  also fail on links that point nowhere

import fs from "node:fs";
import path from "node:path";

const SITE = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(SITE, "..");
const GITHUB = "https://github.com/yiyisf/paseo-req-kit";

/** Repository path → site page (without .md), with titles for the sidebar. */
export const PAGES = [
  ["docs/guide/使用者指南.md", "guide/user"],
  ["docs/guide/安装与升级.md", "guide/install"],
  ["docs/guide/项目定制与运行规则.md", "guide/project"],
  ["docs/guide/维护者指南.md", "guide/maintainer"],
  ["contracts/README.md", "reference/contracts/index"],
  ["contracts/spec.md", "reference/contracts/spec"],
  ["contracts/state.md", "reference/contracts/state"],
  ["contracts/result-file.md", "reference/contracts/result-file"],
  ["contracts/feature-files.md", "reference/contracts/feature-files"],
  ["contracts/verify.md", "reference/contracts/verify"],
  ["contracts/notifier-event.md", "reference/contracts/notifier-event"],
  ["contracts/cli-json.md", "reference/contracts/cli-json"],
  ["contracts/usage-record.md", "reference/contracts/usage-record"],
  ["docs/adr/README.md", "reference/adr/index"],
  ["SCOPE.md", "reference/scope"],
  ["CHANGELOG.md", "changelog"],
];
for (const file of fs.readdirSync(path.join(REPO, "docs", "adr")).sort()) {
  if (/^\d{4}-.*\.md$/.test(file)) PAGES.push([`docs/adr/${file}`, `reference/adr/${file.replace(/\.md$/, "")}`]);
}

const bySource = new Map(PAGES.map(([src, page]) => [src, page]));
const DIR_INDEX = new Map([
  ["contracts", "reference/contracts/index"],
  ["docs/adr", "reference/adr/index"],
]);

const problems = [];

function rewriteLink(sourceFile, target) {
  if (/^([a-z]+:|#|\/)/i.test(target)) return target;
  const [rawPath, hash = ""] = target.split("#");
  const anchor = hash ? `#${hash}` : "";
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile), decodeURIComponent(rawPath)));
  const clean = resolved.replace(/\/$/, "");
  const page = bySource.get(clean) ?? DIR_INDEX.get(clean);
  const from = bySource.get(sourceFile);
  if (page) {
    let rel = path.posix.relative(path.posix.dirname(from), page);
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return `${rel.replace(/\/index$/, "/")}${anchor}`;
  }
  const abs = path.join(REPO, clean);
  if (!fs.existsSync(abs)) problems.push(`${sourceFile}: 链接指向不存在的 ${target}`);
  const kind = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? "tree" : "blob";
  return `${GITHUB}/${kind}/main/${clean}${anchor}`;
}

function convert(sourceFile) {
  const text = fs.readFileSync(path.join(REPO, sourceFile), "utf8");
  let inFence = false;
  const lines = text.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) return line;
    // Links outside inline code: [text](target)
    return line.replace(/(`[^`]*`)|\]\(([^)\s]+)\)/g, (m, code, target) => (code ? code : `](${rewriteLink(sourceFile, target)})`));
  });
  const edit = `${GITHUB}/edit/main/${sourceFile}`;
  return [
    "---",
    `editLink: false`,
    "---",
    "",
    // Vue would read {{ … }} in these texts as template syntax.
    "::: v-pre",
    lines.join("\n").trimEnd(),
    ":::",
    "",
    `<p class="source-note">本页由仓库中的 <a href="${GITHUB}/blob/main/${sourceFile}">${sourceFile}</a> 生成。<a href="${edit}">在 GitHub 上编辑</a></p>`,
    "",
  ].join("\n");
}

const generated = [];
for (const [src, page] of PAGES) {
  const out = path.join(SITE, `${page}.md`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, convert(src));
  generated.push(`/${page}.md`);
}
// Installers served from the site too: https://<site>/install.sh
for (const file of ["install.sh", "install.ps1"]) fs.copyFileSync(path.join(REPO, file), path.join(SITE, "public", file));
generated.push("/public/install.sh", "/public/install.ps1");
fs.writeFileSync(path.join(SITE, ".generated.json"), `${JSON.stringify(generated, null, 2)}\n`);

console.log(`已生成 ${PAGES.length} 页`);
if (problems.length > 0) {
  console.error(problems.join("\n"));
  if (process.argv.includes("--check")) process.exit(1);
}
