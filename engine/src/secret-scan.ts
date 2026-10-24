// Secret scan (1.14): before the change leaves the step (quality gate) and before the branch
// leaves the machine (push), the pipeline looks for keys, tokens and passwords in what the
// requirement added: the lines its commits added since the base and the changes not yet
// committed. Well-known key formats are found anywhere; "password = ..." style assignments
// only outside tests and docs, and not when the value is a placeholder or read from the
// environment. A line with "req-kit:allow-secret" (or "gitleaks:allow") is skipped.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { matchesPath } from "./gate.js";

export interface SecretScanSettings {
  enabled: boolean;
  /** Files never scanned (paths or globs, e.g. "test/fixtures/**"). */
  allow: string[];
}

export interface SecretFinding {
  file: string;
  line: number;
  /** The commit that added it (short), or null for a change not committed yet. */
  commit: string | null;
  /** What it looks like, for the person ("私钥", "GitLab 令牌", "口令"). */
  kind: string;
  /** The line with the secret masked. */
  preview: string;
}

const STRONG: Array<{ re: RegExp; kind: string }> = [
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----/, kind: "私钥" },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, kind: "AWS 访问密钥" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/, kind: "GitHub 令牌" },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}\b/, kind: "GitLab 令牌" },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, kind: "Slack 令牌" },
  { re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b/, kind: "模型服务的 API 密钥" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, kind: "Google API 密钥" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, kind: "令牌（JWT）" },
  { re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:([^\s@/'"]{4,})@[^\s'"]+/i, kind: "地址里带口令" },
];

const ASSIGN = /(?:^|[\s"'{(,;])([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential)[A-Za-z0-9_.-]*)["']?\s*(?:[:=]|:=|=>)\s*(["'`]?)([^\s"'`,;)}]+)\2/i;

/** Values that are not secrets: placeholders, environment lookups, words, booleans. */
function placeholder(value: string): boolean {
  const v = value.trim();
  if (v.length < 8) return true;
  if (/[${}<>%]|\(|\[|^\*+$|^x+$|^\.+$/i.test(v)) return true;
  if (/^(true|false|null|none|undefined|nil|required|optional|string|number|boolean)$/i.test(v)) return true;
  if (/(change.?me|example|sample|dummy|fake|mock|placeholder|your[_-]?|xxx|todo|redacted|\*\*\*|test|demo|secret|password|token)/i.test(v)) return true;
  // Code, not a value: a property path or a function name.
  if (/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)+$/.test(v) || /^(process\.env|os\.environ|System\.getenv|env\.)/.test(v)) return true;
  // A secret has some mix: letters and digits, or symbols.
  return !(/[A-Za-z]/.test(v) && (/\d/.test(v) || /[^A-Za-z0-9]/.test(v)));
}

const TEST_OR_DOC = /(^|\/)(tests?|__tests__|spec|specs|fixtures?|mocks?|testdata|examples?|docs?)\/|\.(test|spec)\.[a-z]+$|_test\.go$|Test\.java$|\.(md|txt|rst|adoc)$/i;
const SKIP_FILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock)$|\.(min\.js|map|svg|png|jpe?g|gif|ico|pdf|zip|jar|woff2?)$/i;
const ALLOW_MARK = /req-kit:allow-secret|gitleaks:allow/;

function mask(line: string, secret: string): string {
  const shown = secret.length > 6 ? `${secret.slice(0, 4)}…` : "…";
  const text = line.replace(secret, shown).trim();
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

/** The secret on one added line, if any. */
export function secretInLine(file: string, line: string): { kind: string; preview: string } | null {
  if (ALLOW_MARK.test(line)) return null;
  for (const { re, kind } of STRONG) {
    const m = re.exec(line);
    if (m) {
      if (kind === "地址里带口令" && placeholder(m[1])) continue;
      return { kind, preview: mask(line, m[1] ?? m[0]) };
    }
  }
  if (TEST_OR_DOC.test(file)) return null;
  const a = ASSIGN.exec(line);
  if (a && !placeholder(a[3])) return { kind: "口令或密钥", preview: mask(line, a[3]) };
  return null;
}

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  } catch {
    return null;
  }
}

/** Added lines of a patch (git log -p / git diff), with the file, the line in the new file and the commit. */
export function scanPatch(patch: string, allow: string[] = []): SecretFinding[] {
  const out: SecretFinding[] = [];
  let commit: string | null = null;
  let file = "";
  let line = 0;
  for (const raw of patch.split("\n")) {
    const c = /^commit ([0-9a-f]{7,40})$/.exec(raw) ?? /^([0-9a-f]{40})\0?$/.exec(raw);
    if (c) {
      commit = c[1].slice(0, 8);
      continue;
    }
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "").trim();
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) {
      line = Number(h[1]);
      continue;
    }
    if (!file || file === "/dev/null") continue;
    if (raw.startsWith("+")) {
      if (!SKIP_FILE.test(file) && !file.includes("/.pipeline/") && !allow.some((p) => matchesPath(file, p))) {
        const s = secretInLine(file, raw.slice(1));
        if (s) out.push({ file, line, commit, ...s });
      }
      line += 1;
    } else if (raw.startsWith(" ")) line += 1;
  }
  return out;
}

/**
 * Secrets the requirement added since `base`: in its commits (each commit's added lines) and in
 * changes not committed yet (including new files). Null when it cannot be told (no git, no base).
 */
export function scanChange(repo: string, base: string | null, settings: Pick<SecretScanSettings, "allow">): SecretFinding[] | null {
  if (!base || git(repo, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]) === null) return null;
  const history = git(repo, ["log", "-p", "--no-color", "--no-ext-diff", "--format=commit %H", "-U0", `${base}..HEAD`]);
  if (history === null) return null;
  const pending = git(repo, ["diff", "--no-color", "--no-ext-diff", "-U0", "HEAD"]) ?? "";
  const findings = [...scanPatch(history, settings.allow), ...scanPatch(pending, settings.allow)];
  for (const f of (git(repo, ["ls-files", "--others", "--exclude-standard"]) ?? "").split("\n").map((s) => s.trim()).filter(Boolean)) {
    if (SKIP_FILE.test(f) || f.includes("/.pipeline/") || settings.allow.some((p) => matchesPath(f, p))) continue;
    const abs = path.join(repo, f);
    try {
      if (fs.statSync(abs).size > 1024 * 1024) continue;
      const lines = fs.readFileSync(abs, "utf8").split("\n");
      lines.forEach((l, i) => {
        const s = secretInLine(f, l);
        if (s) findings.push({ file: f, line: i + 1, commit: null, ...s });
      });
    } catch {
      /* unreadable: skip */
    }
  }
  // The same line found in a commit and still pending counts once.
  const seen = new Set<string>();
  return findings.filter((f) => {
    const k = `${f.file}:${f.preview}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function describeFinding(f: SecretFinding): string {
  return `${f.file}:${f.line}（${f.kind}${f.commit ? `，提交 ${f.commit}` : "，还没提交"}）：${f.preview}`;
}

/** What the step's agent is told when the scan finds something. */
export function secretFollowUp(input: { findings: SecretFinding[]; base: string; round: number; max: number }): string {
  const commits = [...new Set(input.findings.map((f) => f.commit).filter((c): c is string => !!c))];
  return [
    `流水线在你这一步结束后检查了本需求新增的内容，发现疑似密钥、令牌或口令（第 ${input.round} 次要求处理，最多 ${input.max} 次）：`,
    "",
    ...input.findings.slice(0, 30).map((f) => `- ${describeFinding(f)}`),
    "",
    "请处理：",
    "1. 从文件里去掉这些值，改成从配置或环境变量读取（配置示例里只写变量名或占位符，例如 `<your-token>`）。测试需要的值用明显的假数据。",
    commits.length > 0
      ? `2. 这些值已经写进了本需求的提交（${commits.join("、")}）。这些提交还没有推送，要把它们从历史里去掉：改好文件后用 \`git commit --fixup=<那个提交>\` 提交，再运行 \`git -c sequence.editor=: rebase -i --autosquash <那个提交>^\`（不会打开编辑器）；只在本需求的分支上做，不要动 ${input.base.slice(0, 8)} 之前的提交。`
      : "2. 这些值还没有提交，改好文件再提交即可。",
    "3. 确实不是密钥的（例如示例里的假值），在那一行末尾加注释 `req-kit:allow-secret`。",
    "4. 在本步骤产物里记一笔：哪些地方、怎么处理的。如果它是真实的密钥，写明\"建议更换这个密钥\"，由人来做。",
  ].join("\n");
}
