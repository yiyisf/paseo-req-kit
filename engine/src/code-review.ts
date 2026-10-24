// Code review in the plugin (1.14): the requirement's change as a diff, the AI review's findings
// placed on the lines they are about, and a person's review on top: comments on lines, "要改" /
// "不用改" on each AI finding, reviewers (from CODEOWNERS, editable), then "退回修改" (a new
// incremental attempt handles the comments) or "评审通过" (recorded for the merge request).
// Plain git and file parsing, no model.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { section } from "./checklist.js";
import { ownersFor, readCodeowners } from "./codeowners.js";
import { KIT_ROOT } from "./locations.js";
import { appendEvent, requirementRef } from "./records.js";
import { isAlive, readState, statePath } from "./state.js";
import { readWorktreeRecord } from "./worktree.js";

export interface DiffLine {
  /** "+" added, "-" removed, " " context. */
  t: "+" | "-" | " ";
  o: number | null;
  n: number | null;
  s: string;
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
  /** The requirement's own documents (spec, design, …): shown last, folded. */
  doc: boolean;
  hunks: Array<{ header: string; lines: DiffLine[] }>;
  /** Too big to show whole. */
  truncated: boolean;
}

export type Severity = "阻塞" | "重要" | "建议" | "待核实";

export interface Finding {
  id: string;
  round: number;
  severity: Severity;
  file: string | null;
  line: number | null;
  title: string;
  suggestion: string | null;
  /** What the fix step recorded: fixed, rejected (不成立), wontfix (不修复), or open. */
  status: "open" | "fixed" | "rejected" | "wontfix";
}

export interface HumanItem {
  id: string;
  file: string | null;
  line: number | null;
  text: string;
  /** The AI finding it takes up, if any. */
  finding: string | null;
}

export interface HumanReview {
  status: "approved" | "changes_requested";
  at: string;
  reviewer: string;
  reviewers: string[];
  /** The commit that was reviewed. */
  head: string | null;
  items: HumanItem[];
  note: string;
  /** For changes_requested: the attempt that took the comments up (null until a run starts). */
  consumedAttempt: number | null;
}

const MAX_LINES_PER_FILE = 3000;
const MAX_LINES_TOTAL = 20000;

function git(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function read(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Where the requirement's change starts: the fork point from the branch it was cut from. */
export function baseOf(repo: string, featureDir: string): { ref: string | null; commit: string | null } {
  const state = readState(statePath(repo, featureDir));
  const source = state?.worktree?.sourceRepo ?? null;
  const recorded = source ? readWorktreeRecord(source, featureDir)?.baseRef ?? null : null;
  const branch = (git(repo, "rev-parse", "--abbrev-ref", "HEAD") ?? "").trim();
  const remoteHead = (git(repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD") ?? "").trim();
  const candidates = [recorded, remoteHead || null, "main", "master", "origin/main", "origin/master"].filter((x): x is string => !!x && x !== branch);
  for (const ref of candidates) {
    const mb = (git(repo, "merge-base", "HEAD", ref) ?? "").trim();
    const head = (git(repo, "rev-parse", "HEAD") ?? "").trim();
    if (mb && mb !== head) return { ref, commit: mb };
  }
  // On the base branch itself, or no common history: the baseline the implementation wrote down.
  const baseline = /基线提交[^0-9a-f]{0,40}([0-9a-f]{7,40})/.exec(read(path.join(repo, featureDir, "implementation.md")))?.[1] ?? null;
  return { ref: null, commit: baseline && git(repo, "cat-file", "-e", `${baseline}^{commit}`) !== null ? baseline : null };
}

/** `git diff` output as files and hunks. */
export function parseDiff(text: string, featureDir: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffFile["hunks"][number] | null = null;
  let o = 0;
  let n = 0;
  let total = 0;
  let inFile = 0;
  const unquote = (p: string) => p.replace(/^"|"$/g, "").replace(/^[ab]\//, "");
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line);
      const p = m ? m[2] : line.slice(11);
      file = { path: p, oldPath: null, status: "modified", additions: 0, deletions: 0, binary: false, doc: p === featureDir || p.startsWith(`${featureDir}/`), hunks: [], truncated: false };
      files.push(file);
      hunk = null;
      inFile = 0;
      continue;
    }
    if (!file) continue;
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("Binary files ")) file.binary = true;
    else if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      if (line.startsWith("+++ ") && line !== "+++ /dev/null") file.path = unquote(line.slice(4));
    } else if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      o = m ? Number(m[1]) : 0;
      n = m ? Number(m[2]) : 0;
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
    } else if (hunk && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      const t = line[0] as DiffLine["t"];
      if (t === "+") file.additions++;
      if (t === "-") file.deletions++;
      if (inFile >= MAX_LINES_PER_FILE || total >= MAX_LINES_TOTAL) {
        file.truncated = true;
        continue;
      }
      hunk.lines.push({ t, o: t === "+" ? null : o, n: t === "-" ? null : n, s: line.slice(1) });
      if (t !== "+") o++;
      if (t !== "-") n++;
      inFile++;
      total++;
    }
  }
  // Code first, then the requirement's documents.
  return [...files.filter((f) => !f.doc), ...files.filter((f) => f.doc)];
}

const SEVERITIES: Array<[RegExp, Severity]> = [
  [/阻塞|blocker|critical|high/i, "阻塞"],
  [/重要|major|medium/i, "重要"],
  [/待核实|unverified|unsure/i, "待核实"],
  [/建议|minor|low|nit|suggest/i, "建议"],
];

function severityOf(text: unknown): Severity {
  const s = String(text ?? "");
  for (const [re, v] of SEVERITIES) if (re.test(s)) return v;
  return "重要";
}

function locationOf(text: string): { file: string | null; line: number | null } {
  const m = /([\w@./\\-]+\.[A-Za-z0-9]+)(?::(\d+))?/.exec(text);
  return { file: m ? m[1].replace(/\\/g, "/") : null, line: m?.[2] ? Number(m[2]) : null };
}

/** The fix step's record for each CR: fixed / rejected / won't fix. */
function statuses(review: string): Map<string, Finding["status"]> {
  const out = new Map<string, Finding["status"]>();
  const lines = review.split(/\r?\n/);
  let inRecord = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) inRecord = /处理记录/.test(line);
    if (!inRecord) continue;
    for (const m of line.matchAll(/CR-(\d+)/g)) {
      const id = `CR-${m[1]}`;
      if (/不成立|驳回|不认可/.test(line)) out.set(id, "rejected");
      else if (/不修复|暂不|以后再|不改/.test(line)) out.set(id, "wontfix");
      else if (/已修复|修复|已改|已处理|fixed/i.test(line)) out.set(id, "fixed");
    }
  }
  return out;
}

/**
 * The AI review's findings: the structured ones the review step put in its result file
 * (`findings`), or, from older runs, the CR items of code-review.md.
 */
export function aiFindings(repo: string, featureDir: string): { findings: Finding[]; rounds: Array<{ round: number; verdict: string }> } {
  const state = readState(statePath(repo, featureDir));
  const review = read(path.join(repo, featureDir, "code-review.md"));
  const status = statuses(review);
  const rounds: Array<{ round: number; verdict: string }> = [];
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(state?.results ?? {})) {
    const m = /^code_review(?:-r(\d+))?$/.exec(key);
    if (!m) continue;
    const round = Number(m[1] ?? 1);
    rounds.push({ round, verdict: String(value.verdict ?? "") });
    const list = Array.isArray(value.findings) ? (value.findings as Array<Record<string, unknown>>) : [];
    list.forEach((f, i) => {
      if (!f || typeof f !== "object") return;
      const title = String(f.title ?? f.problem ?? f.issue ?? f.description ?? "").trim();
      if (!title) return;
      const id = String(f.id ?? `CR-${round}.${i + 1}`).trim();
      if (seen.has(id)) return;
      seen.add(id);
      const loc = typeof f.file === "string" ? { file: f.file.replace(/\\/g, "/"), line: Number.parseInt(String(f.line ?? ""), 10) || null } : locationOf(String(f.location ?? ""));
      findings.push({ id, round, severity: severityOf(f.severity ?? f.level), file: loc.file, line: loc.line, title: title.slice(0, 600), suggestion: typeof f.suggestion === "string" ? f.suggestion.slice(0, 600) : typeof f.fix === "string" ? f.fix.slice(0, 600) : null, status: status.get(id) ?? "open" });
    });
  }
  rounds.sort((a, b) => a.round - b.round);
  if (findings.length === 0 && review) {
    // Older runs: "CR-3（重要）src/a.ts:12 …" items in code-review.md.
    const lines = review.split(/\r?\n/);
    let round = 1;
    let heading = "";
    for (let i = 0; i < lines.length; i++) {
      if (/^#{1,6}\s/.test(lines[i])) {
        heading = lines[i];
        const r = /第\s*(\d+)\s*轮/.exec(heading);
        if (r) round = Number(r[1]);
      }
      // Items are where they are raised, not where the fix step records them.
      if (/处理记录|人工评审/.test(heading) && !/^#{1,6}\s+(?:\**)?CR-/.test(lines[i])) continue;
      const m = /^\s*(?:[-*]|#{1,6}|\d+[.、])?\s*\**\s*(CR-\d+)\b\**[\s:：.、)）-]*(.*)$/.exec(lines[i]);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      const block = [m[2], ...lines.slice(i + 1, i + 8).filter((l) => l.trim() && !/CR-\d+/.test(l) && !/^#{1,6}\s/.test(l))].join(" ");
      const loc = locationOf(block);
      const title = block.replace(/\*\*/g, "").replace(/级别[:：]\s*\S+/, "").replace(/位置[:：]\s*\S+/, "").replace(/\s+/g, " ").trim();
      findings.push({ id: m[1], round, severity: severityOf(block), file: loc.file, line: loc.line, title: title.slice(0, 600) || m[1], suggestion: null, status: status.get(m[1]) ?? "open" });
    }
  }
  return { findings, rounds };
}

const humanDir = (featureAbs: string) => path.join(featureAbs, ".pipeline", "code-review");

export function readHumanReview(featureAbs: string): HumanReview | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(humanDir(featureAbs), "human.json"), "utf8")) as HumanReview;
  } catch {
    return null;
  }
}

export function writeHumanReview(featureAbs: string, review: HumanReview): void {
  fs.mkdirSync(humanDir(featureAbs), { recursive: true });
  fs.writeFileSync(path.join(humanDir(featureAbs), "human.json"), JSON.stringify(review, null, 2));
}

export interface CodeReviewData {
  title: string;
  featureDir: string;
  branch: string | null;
  base: { ref: string | null; commit: string | null };
  head: string | null;
  files: DiffFile[];
  findings: Finding[];
  rounds: Array<{ round: number; verdict: string }>;
  /** handoff.md "这次改了什么": the change in plain words. */
  summary: string[];
  reviewers: { suggested: string[]; byFile: Record<string, string[]>; source: string | null };
  human: (HumanReview & { stale: boolean }) | null;
  status: string | null;
  running: boolean;
}

export function buildCodeReview(repo: string, featureDir: string): CodeReviewData {
  const featureAbs = path.join(repo, featureDir);
  const state = readState(statePath(repo, featureDir));
  const base = baseOf(repo, featureDir);
  const head = (git(repo, "rev-parse", "HEAD") ?? "").trim() || null;
  const diff = base.commit ? (git(repo, "diff", "--no-color", "--no-ext-diff", "-M", "--unified=3", `${base.commit}..HEAD`) ?? "") : "";
  const files = parseDiff(diff, featureDir);
  const { findings, rounds } = aiFindings(repo, featureDir);
  const owners = readCodeowners(repo);
  const code = files.filter((f) => !f.doc).map((f) => f.path);
  const o = owners ? ownersFor(owners.rules, code) : { byFile: {}, all: [] };
  const spec = read(path.join(featureAbs, "spec.md"));
  const human = readHumanReview(featureAbs);
  const summary = section(read(path.join(featureAbs, "handoff.md")), /这次改了什么|改了什么|改动概要|变更内容/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim())
    .slice(0, 30);
  return {
    title: (/^#\s+(.+)$/m.exec(spec)?.[1] ?? path.basename(featureDir)).replace(/^需求说明[:：\s]*/, "").trim(),
    featureDir,
    branch: state?.branch ?? ((git(repo, "rev-parse", "--abbrev-ref", "HEAD") ?? "").trim() || null),
    base,
    head,
    files,
    findings,
    rounds,
    summary,
    reviewers: { suggested: o.all, byFile: o.byFile, source: owners?.file ?? null },
    human: human ? { ...human, stale: human.status === "approved" && !!head && human.head !== head } : null,
    status: state?.status ?? null,
    running: !!state && state.status === "running" && isAlive(state.pid),
  };
}

export interface Submission {
  verdict: "approve" | "changes";
  reviewer: string;
  reviewers: string[];
  comments: Array<{ file: string | null; line: number | null; text: string }>;
  /** AI findings the reviewer wants fixed, with an optional remark. */
  fix: Array<{ id: string; note?: string }>;
  note: string;
}

function commitDocs(repo: string, files: string[], message: string): boolean {
  const rels = files.filter((f) => fs.existsSync(path.join(repo, f)));
  if (git(repo, "rev-parse", "--git-dir") === null || rels.length === 0) return false;
  if (git(repo, "add", "--", ...rels) === null) return false;
  if (!(git(repo, "diff", "--cached", "--name-only", "--", ...rels) ?? "").trim()) return false;
  return git(repo, "commit", "-q", "-m", message, "--", ...rels) !== null;
}

/** The person's review, recorded in code-review.md (and changes.md when changes are asked for). */
export function recordHumanReview(repo: string, featureDir: string, sub: Submission, now = new Date()): { review: HumanReview; committed: boolean } {
  const featureAbs = path.join(repo, featureDir);
  const data = buildCodeReview(repo, featureDir);
  const byId = new Map(data.findings.map((f) => [f.id, f]));
  const items: HumanItem[] = [];
  for (const f of sub.fix) {
    const found = byId.get(f.id);
    if (!found) continue;
    items.push({ id: `HR-${items.length + 1}`, file: found.file, line: found.line, finding: found.id, text: `AI 评审意见 ${found.id}（${found.severity}）：${found.title}${f.note?.trim() ? `。评审人补充：${f.note.trim()}` : ""}` });
  }
  for (const c of sub.comments) {
    if (!c.text?.trim()) continue;
    items.push({ id: `HR-${items.length + 1}`, file: c.file, line: c.line, finding: null, text: c.text.trim().slice(0, 2000) });
  }
  if (sub.note.trim() && sub.verdict === "changes") items.push({ id: `HR-${items.length + 1}`, file: null, line: null, finding: null, text: sub.note.trim().slice(0, 2000) });
  const date = now.toISOString().slice(0, 10);
  const reviewer = sub.reviewer.trim().slice(0, 60) || "评审人（插件）";
  const review: HumanReview = {
    status: sub.verdict === "approve" ? "approved" : "changes_requested",
    at: now.toISOString(),
    reviewer,
    reviewers: [...new Set(sub.reviewers.map((r) => r.trim()).filter(Boolean))].slice(0, 20),
    head: data.head,
    items,
    note: sub.note.trim().slice(0, 2000),
    consumedAttempt: null,
  };
  const where = (i: HumanItem) => (i.file ? `[${i.file}${i.line ? `:${i.line}` : ""}] ` : "");
  const block = [
    "",
    `## 人工评审（${date}，${reviewer}）`,
    "",
    `- 结论：${sub.verdict === "approve" ? "通过" : "需要修改"}`,
    `- 评审的提交：${data.head ?? "（未知）"}`,
    `- 审核人：${review.reviewers.length ? review.reviewers.join("、") : "（未指定）"}`,
    ...(sub.verdict === "approve" && review.note ? [`- 说明：${review.note}`] : []),
    ...(items.length ? ["", ...items.map((i) => `- **${i.id}** ${where(i)}${i.text}`)] : []),
    ...(sub.verdict === "changes" ? ["", "以上 HR 意见由下一次尝试逐条处理；处理记录写在这一节之后。"] : []),
    "",
  ].join("\n");
  const reviewFile = path.join(featureAbs, "code-review.md");
  fs.appendFileSync(reviewFile, fs.existsSync(reviewFile) ? block : `# 代码评审\n${block}`);
  const touched = [path.join(featureDir, "code-review.md")];
  if (sub.verdict === "changes") {
    const changes = path.join(featureAbs, "changes.md");
    const n = (read(changes).match(/人工代码评审退回/g) ?? []).length + 1;
    const text = [
      "",
      `## ${date} 人工代码评审退回（第 ${n} 次）`,
      "",
      "- 来源：人工代码评审",
      `- 内容：${reviewer} 提出了 ${items.length} 条修改意见，见 code-review.md 的“人工评审（${date}，${reviewer}）”一节（HR-1 起）`,
      "- 处理：从方案设计开始只处理这些意见（需求说明不变），修改经过代码评审后重新验证",
      "",
    ].join("\n");
    fs.appendFileSync(changes, fs.existsSync(changes) ? text : `# 变更记录\n${text}`);
    touched.push(path.join(featureDir, "changes.md"));
  }
  writeHumanReview(featureAbs, review);
  const committed = commitDocs(repo, touched, `docs(${path.basename(featureDir)}): 人工代码评审${sub.verdict === "approve" ? "通过" : "意见"}`);
  // A new review replaces the draft.
  fs.rmSync(path.join(humanDir(featureAbs), "draft.json"), { force: true });
  // 1.14: the review also goes into the usage records, for req stats.
  appendEvent({ kind: "review", at: review.at, requirement: requirementRef(repo, featureDir), review: { verdict: review.status, reviewer, items: items.length, head: review.head } });
  return { review, committed };
}

/** Starts the attempt that handles the comments: `req review-fix <需求>` in the requirement's checkout. */
export function startReviewFix(repo: string, featureDir: string): { ok: boolean; message: string } {
  const state = readState(statePath(repo, featureDir));
  const cwd = state?.worktree?.sourceRepo ?? repo;
  const env = { ...process.env };
  delete env.PASEO_AGENT_ID;
  delete env.PASEO_AGENT_CWD;
  const r = spawnSync(process.execPath, [path.join(KIT_ROOT, "bin", "req.mjs"), "review-fix", featureDir], { cwd, env, encoding: "utf8", timeout: 180_000, windowsHide: true });
  return { ok: r.status === 0, message: r.error ? r.error.message : `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** Comments waiting for an attempt to take them up (for `--review-fix`). */
export function pendingHumanReview(featureAbs: string): HumanReview | null {
  const r = readHumanReview(featureAbs);
  return r && r.status === "changes_requested" && r.consumedAttempt === null ? r : null;
}
