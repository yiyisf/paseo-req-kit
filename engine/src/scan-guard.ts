// Stopping commands that search very large directories (1.13): a step agent that looks for a
// class or a package by searching the whole home directory, the Maven repository (~/.m2), the
// global node_modules or a drive can sit for many minutes and never finish the step. While a step
// runs, the pipeline looks at the agent's running tool call about once a minute; a search of such
// a directory (after a minute) or any search that runs too long is interrupted, and the agent is
// told how to find what it needs without the scan. A plain check of the command text, no model.
import os from "node:os";

export interface RunningTool {
  /** Paseo's tool kind: "shell", "search", … */
  kind: string;
  /** The command (shell) or the pattern (search). */
  text: string;
  /** When the call started (ISO time). */
  startedAt: string;
  /** The tool call's ID, so the same call is interrupted at most once. */
  callId: string;
}

export interface ScanGuardSettings {
  enabled: boolean;
  /** A search that runs this long is interrupted wherever it searches. */
  minutes: number;
  /** More directories never to be searched as a whole (e.g. a shared drive). */
  paths: string[];
}

/** A search of a large directory gets this long before it is interrupted (most are quick to fail or finish). */
export const BIG_DIR_GRACE_MS = 60_000;

/** Commands that walk a directory tree. */
const SCAN_COMMAND =
  /(^|[\s;&|("'`])(find|fd|locate|mlocate|tree|du|rg|ag|ack|grep\s+(-\w*[rR]\w*|--recursive)|egrep\s+-\w*[rR]|ls\s+(-\w*R\w*)|Get-ChildItem\b[^|;]*-r(ecurse)?\b|gci\b[^|;]*-r(ecurse)?\b|dir\b[^|;]*(\/s\b|-r(ecurse)?\b)|findstr\b[^|;]*\/s\b|where\s+\/r|Select-String\b[^|;]*-Path\b[^|;]*\*\*)(?=$|[\s;&|)"'`])/i;

/** Option values that keep a directory out of a search: not what it searches. */
const EXCLUSIONS = [
  /--exclude(-dir)?(=|\s+)("[^"]*"|'[^']*'|\S+)/gi,
  /(-g|--glob|--iglob)(=|\s+)("![^"]*"|'![^']*'|!\S+)/gi,
  /(-not|!)\s+-(i?path|i?name|wholename)\s+("[^"]*"|'[^']*'|\S+)/gi,
  /-(i?path|i?name|wholename)\s+("[^"]*"|'[^']*'|\S+)\s+-prune/gi,
  /--(ignore-dir|ignore-directory|exclude-from)(=|\s+)("[^"]*"|'[^']*'|\S+)/gi,
  /-Exclude\s+("[^"]*"|'[^']*'|\S+)/gi,
];

const END = String.raw`(?=$|[\s"'*;|&)\]` + "`" + `])`;
const START = String.raw`(?:^|[\s"'=(\[` + "`" + `])`;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s: string) => s.replace(/\\/g, "/");

interface BigDir {
  re: RegExp;
  label: string;
}

function bigDirs(home: string, extra: string[]): BigDir[] {
  const h = escape(norm(home).replace(/\/+$/, ""));
  const homes = String.raw`(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE|\$env:HOME${h ? `|${h}` : ""})`;
  const sub = (p: string) => new RegExp(`${START}(?:${homes}/|[^\\s"']*/)?${p}/?${END}`, "i");
  const list: BigDir[] = [
    { re: new RegExp(`${START}/${END}`), label: "整个磁盘（/）" },
    { re: new RegExp(`${START}[a-z]:/?${END}`, "i"), label: "整个磁盘" },
    { re: new RegExp(`${START}${homes}/?${END}`, "i"), label: "用户目录" },
    { re: sub(String.raw`\.m2(?:/repository)?`), label: "Maven 本地仓库（.m2）" },
    { re: sub(String.raw`\.gradle(?:/caches)?`), label: "Gradle 缓存（.gradle）" },
    { re: sub(String.raw`\.ivy2`), label: "Ivy 缓存（.ivy2）" },
    { re: sub(String.raw`(?:\.npm|\.pnpm-store|\.yarn|AppData/Local/(?:npm-cache|pnpm|Yarn))`), label: "npm/pnpm/yarn 缓存" },
    { re: sub(String.raw`(?:\.nvm|\.volta|\.fnm|AppData/Roaming/nvm)`), label: "Node.js 版本目录" },
    { re: sub(String.raw`\.cache`), label: "缓存目录（.cache）" },
    { re: sub(String.raw`(?:\.cargo|go/pkg/mod|\.rustup)`), label: "Rust/Go 依赖缓存" },
    { re: sub(String.raw`AppData(?:/Roaming|/Local)?`), label: "AppData" },
    { re: sub(String.raw`(?:usr/(?:local/)?lib/node_modules|AppData/Roaming/npm(?:/node_modules)?)`), label: "全局 node_modules" },
    { re: /npm\s+root\s+-g|pnpm\s+root\s+-g/i, label: "全局 node_modules" },
    { re: sub("node_modules"), label: "node_modules" },
    { re: new RegExp(`${START}(?:[a-z]:)?/(?:usr(?:/lib|/share|/local)?|opt|var|Library|Program Files(?: \\(x86\\))?|Windows)/?${END}`, "i"), label: "系统目录" },
    { re: sub(String.raw`site-packages`), label: "Python 依赖目录（site-packages）" },
  ];
  for (const p of extra) {
    const n = escape(norm(p).replace(/\/+$/, ""));
    if (n) list.push({ re: new RegExp(`${START}${n}/?${END}`, "i"), label: p });
  }
  return list;
}

/** The large directory a command searches as a whole, or null. */
export function bigDirOf(command: string, options: { home?: string; paths?: string[] } = {}): string | null {
  if (!SCAN_COMMAND.test(command)) return null;
  let text = command;
  for (const re of EXCLUSIONS) text = text.replace(re, " ");
  text = norm(text);
  for (const d of bigDirs(options.home ?? os.homedir(), options.paths ?? [])) if (d.re.test(text)) return d.label;
  return null;
}

export function isScan(tool: Pick<RunningTool, "kind" | "text">): boolean {
  return tool.kind === "search" || (tool.kind === "shell" && SCAN_COMMAND.test(tool.text));
}

export interface ScanVerdict {
  /** Why: the large directory, or how long the search has run. */
  reason: string;
  /** What the agent is told (the interrupt message). */
  message: string;
}

const clip = (s: string, n = 160) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** Whether the running tool call should be interrupted, and what to tell the agent. */
export function judge(tool: RunningTool | null, settings: ScanGuardSettings, now = new Date(), home = os.homedir()): ScanVerdict | null {
  if (!tool || !settings.enabled) return null;
  const ran = now.getTime() - new Date(tool.startedAt).getTime();
  if (!(ran >= 0)) return null;
  const big = tool.kind === "shell" ? bigDirOf(tool.text, { home, paths: settings.paths }) : null;
  let reason: string | null = null;
  if (big && ran >= BIG_DIR_GRACE_MS) reason = `在搜索${big}`;
  else if (isScan(tool) && ran >= settings.minutes * 60_000) reason = `搜索已经运行了 ${Math.round(ran / 60_000)} 分钟`;
  if (!reason) return null;
  return { reason, message: scanMessage(tool.text, reason) };
}

export function scanMessage(command: string, reason: string): string {
  return [
    `【流水线提示】已停止你刚才的${command ? `命令「${clip(command)}」` : "搜索"}：它${reason}，这类搜索要很久，会让这一步一直做不完。请继续完成本步骤的任务，但不要再搜索整个磁盘、用户目录或依赖缓存，改用下面的办法：`,
    "- 在仓库里找：用 `git grep -n <内容>` 或 `git ls-files | grep <文件名>`；用 rg 时只在仓库目录里搜，它会跳过 .gitignore 里的目录。",
    "- 找某个 Maven/Gradle 依赖里的类：先在 pom.xml / build.gradle 里确定 groupId、artifactId 和版本，直接打开 `~/.m2/repository/<groupId 的点换成 />/<artifactId>/<版本>/` 这一个目录，用 `unzip -l <jar> | grep <类名>` 或 `jar tf` 看那一个 jar；要源码时用 `mvn dependency:sources -DincludeArtifactIds=<artifactId>`。不知道是哪个依赖时，`mvn dependency:tree` 比搜索快。",
    "- 找某个 npm 包：直接看仓库里的 `node_modules/<包名>/package.json`，以及其中 main、types 指向的文件；不要搜索整个 node_modules 或全局 node_modules。",
    "- 实在找不到就不要再找了：按项目代码和文档里能确认的信息继续，把不确定的地方写进本步骤产物的\"假设\"一节。",
  ].join("\n");
}
