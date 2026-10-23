// The acceptance checklist (1.14): what the requester checks by hand, built from the spec's
// acceptance criteria, with what the pipeline found for each one. People tick each item on a
// page (or read it with `req checklist`); the result is written as acceptance.md, the same record
// the /req acceptance playbook writes. Plain parsing, no model.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type PipelineResult = "pass" | "fail" | "unverified" | "unknown";

export interface ChecklistItem {
  /** AC-2.1, or D-1 for a decision the report asks the requester to confirm. */
  id: string;
  kind: "criterion" | "decision";
  title: string;
  /** 前置条件 / 操作 / 预期结果 and any example rows, as written in the spec. */
  details: string[];
  /** False for criteria of a "可以以后再说" requirement: they do not decide the verdict. */
  required: boolean;
  pipeline: PipelineResult;
  /** The line of verification.md / report.md the pipeline result was read from. */
  evidence: string | null;
}

export interface Checklist {
  title: string;
  specVersion: string | null;
  reportVerdict: string | null;
  items: ChecklistItem[];
  /** handoff.md: what to watch for (已知问题) and where test data comes from, for the page. */
  notes: string[];
}

const clean = (s: string) => s.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();

function read(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function header(text: string, name: string): string | null {
  const m = new RegExp(`^[-*]\\s*${name}[:：]\\s*(.+)$`, "m").exec(text);
  return m ? m[1].trim() : null;
}

/** The lines under the first heading whose text matches `title` (until the next heading of the same or higher level). */
export function section(text: string, title: RegExp): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && title.test(l));
  if (start < 0) return [];
  const level = /^(#+)/.exec(lines[start])![1].length;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const h = /^(#+)\s/.exec(line);
    if (h && h[1].length <= level) break;
    out.push(line);
  }
  return out;
}

/** The criteria of a spec, with their details and whether their requirement is a must. */
export function parseCriteria(spec: string): Array<Omit<ChecklistItem, "pipeline" | "evidence">> {
  const items: Array<Omit<ChecklistItem, "pipeline" | "evidence">> = [];
  let required = true;
  let current: (typeof items)[number] | null = null;
  for (const raw of spec.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.*)$/.exec(raw);
    if (heading) {
      current = null;
      if (/FR-\d+/.test(heading[1])) required = !/可以以后再说|可选|以后再说/.test(heading[1]);
      continue;
    }
    const ac = /^\s{0,3}[-*]\s+(.*?\bAC-(\d+(?:\.\d+)*)\b.*)$/.exec(raw);
    if (ac) {
      const line = ac[1];
      if (/~~/.test(line) || /已取消/.test(line)) {
        current = null;
        continue;
      }
      const id = `AC-${ac[2]}`;
      if (items.some((i) => i.id === id)) {
        current = null;
        continue;
      }
      const title = clean(line.replace(new RegExp(`.*?\\bAC-${ac[2].replace(/\./g, "\\.")}\\b[\\s*_\`)）\\]】:：-]*`), ""));
      current = { id, kind: "criterion", title: title || id, details: [], required };
      items.push(current);
      continue;
    }
    if (!current) continue;
    if (/^\s*$/.test(raw)) continue;
    // Its details: indented bullets, or a table under it.
    if (/^\s{2,}\S/.test(raw) || /^\s*\|/.test(raw)) {
      const t = raw.trim();
      if (/^\|?\s*-{3,}/.test(t)) continue;
      current.details.push(clean(t.replace(/^[-*]\s+/, "")));
    } else current = null;
  }
  return items;
}

/** A table row as words: "| AC-1.2 | 未验证 | 没有空数据 |" → "AC-1.2，未验证，没有空数据". */
const evidenceOf = (line: string) =>
  clean(line.trim().replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim()).filter(Boolean).join("，")).slice(0, 300);

/** What the pipeline wrote about one criterion, from verification.md (preferred) and report.md. */
export function pipelineResult(id: string, ...documents: string[]): { result: PipelineResult; evidence: string | null } {
  const re = new RegExp(`\\b${id.replace(/\./g, "\\.")}\\b(?![.\\d])`);
  for (const doc of documents) {
    const lines = doc.split(/\r?\n/).filter((l) => re.test(l));
    // The last mention wins: a later round (复验) supersedes an earlier one.
    for (const line of lines.reverse()) {
      if (/未验证|没有验证|无法验证|未验/.test(line)) return { result: "unverified", evidence: evidenceOf(line) };
      if (/未通过|不通过|失败|未达成|没有达成|✗|❌/.test(line)) return { result: "fail", evidence: evidenceOf(line) };
      if (/通过|达成|✓|✅|pass/i.test(line)) return { result: "pass", evidence: evidenceOf(line) };
    }
  }
  return { result: "unknown", evidence: null };
}

/** The decisions the report asks the requester to confirm ("需要你确认的决定"). */
function decisions(report: string): ChecklistItem[] {
  return section(report, /需要你确认/)
    .map((l) => /^\s*(?:[-*]|\d+[.、)])\s+(.+)$/.exec(l)?.[1])
    .filter((x): x is string => !!x && clean(x).length > 0 && !/^(无|没有)/.test(clean(x)))
    .map((text, i) => ({ id: `D-${i + 1}`, kind: "decision" as const, title: clean(text).slice(0, 300), details: [], required: true, pipeline: "unknown" as const, evidence: null }));
}

const ORDER: Record<PipelineResult, number> = { fail: 0, unverified: 1, unknown: 2, pass: 3 };

export function buildChecklist(featureAbs: string): Checklist {
  const spec = read(path.join(featureAbs, "spec.md"));
  const report = read(path.join(featureAbs, "report.md"));
  const verification = read(path.join(featureAbs, "verification.md"));
  const handoff = read(path.join(featureAbs, "handoff.md"));
  const criteria = parseCriteria(spec).map((c) => {
    const { result, evidence } = pipelineResult(c.id, verification, report);
    return { ...c, pipeline: result, evidence };
  });
  // What the pipeline did not verify, or found wrong, first: that is where a person's eyes help most.
  criteria.sort((a, b) => ORDER[a.pipeline] - ORDER[b.pipeline]);
  const notes = [...section(handoff, /已知问题|未完成/), ...section(handoff, /测试需要的准备|测试数据|准备/)]
    .map((l) => clean(l.replace(/^\s*[-*]\s+/, "")))
    .filter((l) => l && !/^(无|没有)[。.]?$/.test(l))
    .slice(0, 20);
  return {
    title: (/^#\s+(.+)$/m.exec(spec)?.[1] ?? path.basename(featureAbs)).replace(/^需求说明[:：\s]*/, "").trim(),
    specVersion: header(spec, "版本"),
    reportVerdict: header(report, "结论") ?? (/结论[:：]\s*(.+)/.exec(report)?.[1]?.trim() ?? null),
    items: [...criteria, ...decisions(report)],
    notes,
  };
}

export type Mark = "pass" | "fail" | "skip";

export interface Answer {
  id: string;
  mark: Mark;
  note?: string;
}

export interface Verdict {
  verdict: "通过" | "不通过";
  failed: ChecklistItem[];
  /** Required items not checked yet: the verdict cannot be "通过" while there are any. */
  missing: ChecklistItem[];
}

export function verdictOf(list: Checklist, answers: Answer[]): Verdict {
  const by = new Map(answers.map((a) => [a.id, a]));
  const failed = list.items.filter((i) => by.get(i.id)?.mark === "fail" && i.required);
  const missing = list.items.filter((i) => i.required && (!by.get(i.id) || by.get(i.id)!.mark === "skip"));
  return { verdict: failed.length > 0 ? "不通过" : "通过", failed, missing };
}

const MARK_TEXT: Record<Mark, string> = { pass: "通过", fail: "不通过", skip: "未验" };

/** acceptance.md in the format of contracts/feature-files.md. Keeps a "不通过的处理" section already there. */
export function acceptanceText(list: Checklist, answers: Answer[], input: { verdict: "通过" | "不通过"; reviewer: string; date: string; previous?: string }): string {
  const by = new Map(answers.map((a) => [a.id, a]));
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  const rows = list.items.map((i) => {
    const a = by.get(i.id);
    const mark = a ? MARK_TEXT[a.mark] : "未验";
    const how = i.kind === "decision" ? "需求方表态（同意 / 不同意）" : "在验收页上亲自核对";
    const note = [i.kind === "decision" ? i.title : null, a?.note?.trim() || null, !i.required ? "可以以后再说，不影响结论" : null].filter(Boolean).join("；");
    return `| ${i.id} | ${i.kind === "decision" ? (a?.mark === "pass" ? "同意" : a?.mark === "fail" ? "不同意" : "未表态") : mark} | ${how} | ${cell(note)} |`;
  });
  const kept = input.previous ? section(input.previous, /不通过的处理/).join("\n").trim() : "";
  const failed = list.items.filter((i) => by.get(i.id)?.mark === "fail");
  const handling = kept || failed.map((i) => `- ${i.id}：${cell(by.get(i.id)?.note?.trim() || i.title)} → 待和需求方确定处理方式（作为缺陷处理 / 作为需求修改 / 接受现状）`).join("\n");
  return [
    `# 验收记录：${list.title}`,
    "",
    `- 验收结论：${input.verdict}（${input.date}）`,
    `- 验收人：${input.reviewer}`,
    `- 对照的需求版本：${list.specVersion ?? "未写明"}`,
    `- 对照的报告：report.md${list.reportVerdict ? `（流水线结论：${list.reportVerdict}）` : ""}`,
    "",
    "| AC | 结果 | 怎么验证的 | 备注 |",
    "| --- | --- | --- | --- |",
    ...rows,
    ...(handling ? ["", "## 不通过的处理", "", handling] : []),
    "",
  ].join("\n");
}

/** Writes acceptance.md and commits it alone (when the feature directory is in a git repository). */
export function recordAcceptance(repo: string, featureDir: string, text: string): { committed: boolean } {
  const file = path.join(repo, featureDir, "acceptance.md");
  fs.writeFileSync(file, text);
  try {
    const rel = path.join(featureDir, "acceptance.md");
    execFileSync("git", ["add", "--", rel], { cwd: repo, stdio: "pipe" });
    const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--", rel], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (!staged) return { committed: false };
    execFileSync("git", ["commit", "-q", "-m", `docs(${path.basename(featureDir)}): 验收记录`, "--", rel], { cwd: repo, stdio: "pipe" });
    return { committed: true };
  } catch {
    return { committed: false };
  }
}

/** What the requirement's chat is told when the requester found problems. */
export function acceptanceFailMessage(featureDir: string, list: Checklist, answers: Answer[]): string {
  const by = new Map(answers.map((a) => [a.id, a]));
  const failed = list.items.filter((i) => by.get(i.id)?.mark === "fail");
  return [
    `【需求开发流水线通知】需求方在验收页上完成了验收（${featureDir}），结论：不通过。验收记录已写入 acceptance.md 并提交。`,
    "",
    "不通过的项：",
    ...failed.map((i) => `- ${i.id} ${i.title}${by.get(i.id)?.note?.trim() ? `：${by.get(i.id)!.note!.trim()}` : ""}`),
    "",
    `请按 /req 的"验收"手册第 5 步，和需求方逐项确定处理方式（实现与需求不符 / 需求本身要改 / 接受现状），记入 acceptance.md 的"不通过的处理"一节，再按对应的手册继续。`,
  ].join("\n");
}

/** `req checklist` in a terminal: the list in words. */
export function checklistText(list: Checklist, url: string | null): string {
  const mark: Record<PipelineResult, string> = { pass: "流水线：通过", fail: "流水线：没通过", unverified: "流水线：没验证", unknown: "流水线：没有记录" };
  const lines = [`# 验收清单：${list.title}`, ""];
  if (list.reportVerdict) lines.push(`流水线结论：${list.reportVerdict}`, "");
  list.items.forEach((i, n) => {
    lines.push(`${n + 1}. ${i.id} ${i.title}${i.required ? "" : "（可以以后再说）"}${i.kind === "criterion" ? `　[${mark[i.pipeline]}]` : "　[请表态：同意 / 不同意]"}`);
    for (const d of i.details) lines.push(`   ${d}`);
  });
  if (list.notes.length) lines.push("", "注意（提测说明）：", ...list.notes.map((n) => `- ${n}`));
  if (url) lines.push("", `在验收页上逐条勾选、写下哪里不对：${url}`);
  return lines.join("\n");
}
