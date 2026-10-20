// `req stats`: what the usage records say about how requirements went (1.9, ADR 0026).
//
//   req stats [--since 30d|2026-10-01] [--month 2026-10]     summary (Markdown)
//             [--json] [--csv]                               the same as JSON / one CSV row per requirement
//             [--report [--out <dir>]]                       report files for management: .md and .csv
//             [--export [<file>]]                            this machine's records for the period, to merge elsewhere
//             [--merge <file>...]                            report on exported files (several machines) instead
//
// Usage of a period counts the runs that ended in it. A requirement's cycle (first start to
// completion) uses all of its runs, so a requirement finished this month counts its whole time.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type RunRecord, readRuns, runsFile } from "./records.js";
import { STEPS, type StepId } from "./steps.js";

export interface Period {
  from: Date | null;
  to: Date | null;
  label: string;
}

const DAY = 24 * 3600_000;

/** --since 30d / 2w / 2026-10-01, --month 2026-10. Default: the last 30 days. */
export function parsePeriod(input: { since?: string | null; month?: string | null }, now = new Date()): Period {
  if (input.month) {
    const m = /^(\d{4})-(\d{1,2})$/.exec(input.month.trim());
    if (!m) throw new Error(`看不懂月份"${input.month}"，请写成 2026-10`);
    const from = new Date(Number(m[1]), Number(m[2]) - 1, 1);
    const to = new Date(Number(m[1]), Number(m[2]), 1);
    return { from, to, label: `${m[1]} 年 ${Number(m[2])} 月` };
  }
  const since = (input.since ?? "30d").trim();
  const rel = /^(\d+)\s*([dw])$/i.exec(since);
  if (rel) {
    const days = Number(rel[1]) * (rel[2].toLowerCase() === "w" ? 7 : 1);
    return { from: new Date(now.getTime() - days * DAY), to: null, label: `最近 ${days} 天` };
  }
  if (since === "all") return { from: null, to: null, label: "全部记录" };
  const at = Date.parse(since);
  if (Number.isNaN(at)) throw new Error(`看不懂"${since}"，可以写 30d、2w、2026-10-01 或 all`);
  return { from: new Date(at), to: null, label: `${since} 以来` };
}

function inPeriod(iso: string, p: Period): boolean {
  const t = new Date(iso).getTime();
  return (!p.from || t >= p.from.getTime()) && (!p.to || t < p.to.getTime());
}

export type WaitKind = "approval" | "business" | "verify" | "interrupted" | "other";

export const WAIT_LABELS: Record<WaitKind, string> = {
  approval: "等待确认方案",
  business: "等待需求方决定",
  verify: "研发完成到开始测试验证",
  interrupted: "中断到继续",
  other: "其他间隔",
};

export interface RequirementStats {
  key: string;
  project: string;
  name: string;
  title: string;
  type: string | null;
  profile: string;
  machines: string[];
  runs: number;
  firstStartedAt: string;
  lastEndedAt: string;
  /** State after the last run. */
  status: string;
  outcome: string | null;
  completedAt: string | null;
  /** First start to completion, hours; null until completed. */
  cycleHours: number | null;
  agentMinutes: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  reviewRounds: number;
  defectRounds: number;
  gateRuns: number;
  gateFailed: number;
  waits: Record<WaitKind, number>;
  builder: string | null;
  reviewer: string | null;
  /** The card's author, for requirements that started from a card (1.10). */
  requester: string | null;
  /** "<system>:<id>" of that card. */
  card: string | null;
}

function add(a: number | null, b: number | null): number | null {
  return b === null ? a : (a ?? 0) + b;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function waitKind(status: string): WaitKind {
  if (status === "waiting_for_approval") return "approval";
  if (status === "waiting_for_business") return "business";
  if (status === "phase_done") return "verify";
  if (status === "failed" || status === "running") return "interrupted";
  return "other";
}

/** Why runs stopped for a person (1.12, state.stopKind). */
export const STOP_LABELS: Record<string, string> = {
  approval: "确认方案",
  phase_gate: "研发完成，等待测试",
  business: "方案审核的问题等需求方决定",
  reproduce: "缺陷复现不了，等需求方补充",
  timeout: "步骤超时",
  agent_error: "agent 报错",
  invalid_result: "结果文件无效",
  transient: "限流、网络等临时错误（自动重试用完）",
  stopped: "被手动停止",
  process_exit: "后台进程意外退出",
  budget: "用完 token 预算",
  other: "其他中断",
};

/** Stops that are the decisions people are meant to make; the rest are what 1.12 works to remove. */
export const NECESSARY_STOPS = ["approval", "phase_gate"];

/** The stop code of a run; older records (before 1.12) are inferred from the status. */
export function stopKindOf(r: RunRecord): string | null {
  if (r.run.stopKind !== undefined) return r.run.stopKind;
  if (r.run.status === "waiting_for_approval") return "approval";
  if (r.run.status === "waiting_for_business") return "business";
  if (r.run.status === "phase_done") return "phase_gate";
  if (r.run.status === "failed") return /手动停止|被 SIG/.test(r.run.stopReason ?? "") ? "stopped" : "other";
  if (r.run.status === "running") return "process_exit";
  return null;
}

/** Records of the same run seen twice (merged exports) count once. */
export function dedupe(runs: RunRecord[]): RunRecord[] {
  const seen = new Map<string, RunRecord>();
  for (const r of runs) seen.set(`${r.machine}\0${r.requirement.key}\0${r.run.startedAt}`, r);
  return [...seen.values()];
}

/** Per requirement, from all of its runs (sorted by start). */
export function byRequirement(runs: RunRecord[]): RequirementStats[] {
  const groups = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const key = `${r.requirement.project}\0${r.requirement.key}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: RequirementStats[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.run.startedAt.localeCompare(b.run.startedAt));
    const last = list.at(-1)!;
    const steps = list.flatMap((r) => r.steps);
    const completed = [...list].reverse().find((r) => r.run.status === "completed");
    const waits: Record<WaitKind, number> = { approval: 0, business: 0, verify: 0, interrupted: 0, other: 0 };
    for (let i = 1; i < list.length; i++) {
      const prev = list.at(i - 1)!;
      const gap = (new Date(list.at(i)!.run.startedAt).getTime() - new Date(prev.run.endedAt).getTime()) / 60_000;
      if (gap > 0) waits[waitKind(prev.run.status)] += round1(gap);
    }
    // Review and defect rounds: distinct (attempt, round) of those steps; a review panel's members count once.
    const rounds = (id: string) => new Set(steps.filter((s) => s.stepId === id).map((s) => `${s.attempt}/${s.round ?? 0}/${s.key.split("@")[1] ?? ""}`)).size;
    out.push({
      key: last.requirement.key,
      project: last.requirement.project,
      name: last.requirement.name,
      title: last.requirement.title,
      type: last.requirement.type,
      profile: last.requirement.profile,
      machines: [...new Set(list.map((r) => r.machine))],
      runs: list.length,
      firstStartedAt: list[0].run.startedAt,
      lastEndedAt: last.run.endedAt,
      status: last.run.status,
      outcome: last.run.status === "completed" ? last.run.outcome : null,
      completedAt: last.run.status === "completed" && completed ? completed.run.endedAt : null,
      cycleHours:
        last.run.status === "completed" && completed
          ? round1((new Date(completed.run.endedAt).getTime() - new Date(list[0].run.startedAt).getTime()) / 3600_000)
          : null,
      agentMinutes: round1(steps.reduce((sum, s) => sum + s.minutes, 0)),
      inputTokens: steps.reduce<number | null>((sum, s) => add(sum, s.inputTokens), null),
      outputTokens: steps.reduce<number | null>((sum, s) => add(sum, s.outputTokens), null),
      costUsd: steps.reduce<number | null>((sum, s) => add(sum, s.costUsd), null),
      reviewRounds: rounds("code_review"),
      defectRounds: rounds("defect_fix"),
      gateRuns: list.reduce((sum, r) => sum + r.gate.runs, 0),
      gateFailed: list.reduce((sum, r) => sum + r.gate.failed, 0),
      waits,
      builder: last.agents.builder,
      reviewer: last.agents.reviewer,
      requester: last.requirement.requester ?? null,
      card: last.requirement.source ? `${last.requirement.source.system}:${last.requirement.source.id}` : null,
    });
  }
  return out.sort((a, b) => b.lastEndedAt.localeCompare(a.lastEndedAt));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s.at(mid)! : round1((s.at(mid - 1)! + s.at(mid)!) / 2);
}

function avg(values: number[]): number | null {
  return values.length === 0 ? null : round1(values.reduce((a, b) => a + b, 0) / values.length);
}

export interface StatsSummary {
  schema: 1;
  period: { from: string | null; to: string | null; label: string };
  machines: string[];
  /** Requirements with a run that ended in the period. */
  active: number;
  /** Completed in the period, by the report's verdict. */
  completed: { total: number; byOutcome: Record<string, number> };
  byType: Record<string, number>;
  /** Hours from first start to completion, of those completed in the period. */
  cycleHours: { median: number | null; average: number | null };
  steps: Array<{ stepId: string; title: string; count: number; averageMinutes: number; totalMinutes: number }>;
  rework: {
    /** Code review rounds per requirement completed in the period. */
    averageReviewRounds: number | null;
    /** Share of completed requirements that needed at least one defect-fix round. */
    withDefectRounds: number | null;
    gateRuns: number;
    gateFailed: number;
  };
  /** Average minutes per requirement that waited, by kind, in the period's runs. */
  waits: Array<{ kind: WaitKind; label: string; requirements: number; averageMinutes: number }>;
  usage: { agentMinutes: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
  /** 1.13: where the tokens (input + output) of the period's runs went. */
  tokens: TokenBreakdown;
  byBuilder: Array<{ builder: string; requirements: number; averageReviewRounds: number | null; averageCostUsd: number | null }>;
  /** 1.12: why the period's runs stopped for a person, most frequent first. */
  stops: Array<{ kind: string; label: string; necessary: boolean; runs: number }>;
  /** 1.12: how much went without a person. */
  automation: {
    /** Of the requirements that reached testing (or completion) in the period, the share with no stop other than the necessary ones. */
    unattendedShare: number | null;
    /** Problems the pipeline handled by itself in the period's runs, by kind. */
    recovered: Record<string, number>;
    /** Runs that ended in an interruption (not a necessary decision). */
    interrupted: number;
    /** recovered / (recovered + interrupted). */
    autoRecoveryShare: number | null;
  };
  /** Requirements that started from cards, by who asked for them (1.10); empty when there are none. */
  byRequester: Array<{ requester: string; requirements: number; completed: number; medianCycleHours: number | null }>;
  requirements: RequirementStats[];
}

export interface TokenBreakdown {
  /** Input + output of the period's steps that reported usage; null when none did. */
  total: number | null;
  /** Share of input tokens served from the prompt cache, when agents report it. */
  cachedShare: number | null;
  byStep: Array<{ stepId: string; title: string; steps: number; tokens: number; share: number }>;
  byAgent: Array<{ agent: string; steps: number; tokens: number; share: number }>;
  /** Fixing and re-checking: revisions, review fixes, defect fixes, re-verification, and review rounds after the first. */
  rework: { tokens: number; share: number } | null;
  /** Tokens per completed requirement (all its runs). */
  perRequirement: { median: number | null; byProfile: Array<{ profile: string; requirements: number; median: number | null }> };
}

const REWORK_STEPS = new Set(["design_revise", "review_fix", "defect_fix", "reverify"]);

export function isRework(s: { stepId: string; round: number | null }): boolean {
  return REWORK_STEPS.has(s.stepId) || ((s.stepId === "design_review" || s.stepId === "code_review") && (s.round ?? 1) > 1);
}

const stepTokens = (s: { inputTokens: number | null; outputTokens: number | null }) =>
  s.inputTokens === null && s.outputTokens === null ? null : (s.inputTokens ?? 0) + (s.outputTokens ?? 0);

export function tokenBreakdown(steps: RunRecord["steps"], done: RequirementStats[]): TokenBreakdown {
  const counted = steps.flatMap((s) => {
    const t = stepTokens(s);
    return t === null ? [] : [{ s, t }];
  });
  const total = counted.length ? counted.reduce((a, x) => a + x.t, 0) : null;
  const share = (n: number) => (total ? Math.round((n / total) * 1000) / 1000 : 0);
  const group = (key: (s: RunRecord["steps"][number]) => string) => {
    const m = new Map<string, { steps: number; tokens: number }>();
    for (const { s, t } of counted) {
      const k = key(s);
      const g = m.get(k) ?? { steps: 0, tokens: 0 };
      m.set(k, { steps: g.steps + 1, tokens: g.tokens + t });
    }
    return [...m.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
  };
  const reworkTokens = counted.filter(({ s }) => isRework(s)).reduce((a, x) => a + x.t, 0);
  const input = steps.reduce((a, s) => a + (s.inputTokens ?? 0), 0);
  const cached = steps.reduce<number | null>((a, s) => (typeof s.cachedInputTokens === "number" ? (a ?? 0) + s.cachedInputTokens : a), null);
  const reqTokens = (q: RequirementStats) => (q.inputTokens === null && q.outputTokens === null ? null : (q.inputTokens ?? 0) + (q.outputTokens ?? 0));
  const profiles = new Map<string, number[]>();
  for (const q of done) {
    const t = reqTokens(q);
    if (t !== null) profiles.set(q.profile, [...(profiles.get(q.profile) ?? []), t]);
  }
  return {
    total,
    cachedShare: cached !== null && input > 0 ? Math.round((cached / input) * 1000) / 1000 : null,
    byStep: group((s) => s.stepId).map(([stepId, g]) => ({ stepId, title: STEPS[stepId as StepId]?.title ?? stepId, steps: g.steps, tokens: g.tokens, share: share(g.tokens) })),
    byAgent: group((s) => s.agent ?? "（未记录）").map(([agent, g]) => ({ agent, steps: g.steps, tokens: g.tokens, share: share(g.tokens) })),
    rework: total ? { tokens: reworkTokens, share: share(reworkTokens) } : null,
    perRequirement: {
      median: median([...profiles.values()].flat()),
      byProfile: [...profiles.entries()].map(([profile, ts]) => ({ profile, requirements: ts.length, median: median(ts) })),
    },
  };
}

/** The summary of a period from run records (any machines). */
export function summarizeRuns(all: RunRecord[], period: Period): StatsSummary {
  const runs = dedupe(all);
  const reqs = byRequirement(runs);
  const periodRuns = runs.filter((r) => inPeriod(r.run.endedAt, period));
  const activeKeys = new Set(periodRuns.map((r) => `${r.requirement.project}\0${r.requirement.key}`));
  const active = reqs.filter((q) => activeKeys.has(`${q.project}\0${q.key}`));
  const done = active.filter((q) => q.completedAt && inPeriod(q.completedAt, period));
  const count = <T extends string>(values: T[]) => values.reduce<Record<string, number>>((m, v) => ({ ...m, [v]: (m[v] ?? 0) + 1 }), {});

  const steps = periodRuns.flatMap((r) => r.steps);
  const byStep = new Map<string, number[]>();
  for (const s of steps) byStep.set(s.stepId, [...(byStep.get(s.stepId) ?? []), s.minutes]);
  const order = Object.keys(STEPS);
  const stepRows = [...byStep.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([stepId, minutes]) => ({
      stepId,
      title: STEPS[stepId as StepId]?.title ?? stepId,
      count: minutes.length,
      averageMinutes: avg(minutes) ?? 0,
      totalMinutes: round1(minutes.reduce((a, b) => a + b, 0)),
    }));

  // Waits of the period: gaps between consecutive runs where the later run started in it.
  const waitTotals = new Map<WaitKind, number[]>();
  for (const q of active) {
    const list = runs.filter((r) => r.requirement.key === q.key && r.requirement.project === q.project).sort((a, b) => a.run.startedAt.localeCompare(b.run.startedAt));
    const per: Partial<Record<WaitKind, number>> = {};
    for (let i = 1; i < list.length; i++) {
      if (!inPeriod(list.at(i)!.run.startedAt, period)) continue;
      const prev = list.at(i - 1)!;
      const gap = (new Date(list.at(i)!.run.startedAt).getTime() - new Date(prev.run.endedAt).getTime()) / 60_000;
      if (gap > 0) per[waitKind(prev.run.status)] = (per[waitKind(prev.run.status)] ?? 0) + gap;
    }
    for (const [k, v] of Object.entries(per) as Array<[WaitKind, number]>) waitTotals.set(k, [...(waitTotals.get(k) ?? []), v]);
  }

  const builders = new Map<string, RequirementStats[]>();
  for (const q of done) builders.set(q.builder ?? "（未记录）", [...(builders.get(q.builder ?? "（未记录）") ?? []), q]);

  const requesters = new Map<string, RequirementStats[]>();
  for (const q of active) if (q.card) requesters.set(q.requester ?? "（未记录）", [...(requesters.get(q.requester ?? "（未记录）") ?? []), q]);

  const stopCounts = count(periodRuns.flatMap((r) => (stopKindOf(r) ? [stopKindOf(r)!] : [])));
  const recovered: Record<string, number> = {};
  for (const r of periodRuns) for (const [k, v] of Object.entries(r.run.recoveries ?? {})) recovered[k] = (recovered[k] ?? 0) + v;
  const recoveredTotal = Object.values(recovered).reduce((a, b) => a + b, 0);
  const interrupted = periodRuns.filter((r) => {
    const k = stopKindOf(r);
    return k !== null && !NECESSARY_STOPS.includes(k) && k !== "business" && k !== "reproduce";
  }).length;
  const reachedTesting = active.filter((q) => q.status === "completed" || q.status === "phase_done");
  const unattended = reachedTesting.filter((q) =>
    runs
      .filter((r) => r.requirement.key === q.key && r.requirement.project === q.project)
      .every((r) => {
        const k = stopKindOf(r);
        return k === null || NECESSARY_STOPS.includes(k);
      }),
  );

  return {
    schema: 1,
    period: { from: period.from?.toISOString() ?? null, to: period.to?.toISOString() ?? null, label: period.label },
    machines: [...new Set(periodRuns.map((r) => r.machine))].sort(),
    active: active.length,
    completed: { total: done.length, byOutcome: count(done.map((q) => q.outcome ?? "unknown")) },
    byType: count(active.map((q) => q.type ?? "normal")),
    cycleHours: { median: median(done.flatMap((q) => (q.cycleHours === null ? [] : [q.cycleHours]))), average: avg(done.flatMap((q) => (q.cycleHours === null ? [] : [q.cycleHours]))) },
    steps: stepRows,
    rework: {
      averageReviewRounds: avg(done.map((q) => q.reviewRounds)),
      withDefectRounds: done.length === 0 ? null : round1((done.filter((q) => q.defectRounds > 0).length / done.length) * 100) / 100,
      gateRuns: periodRuns.reduce((s, r) => s + r.gate.runs, 0),
      gateFailed: periodRuns.reduce((s, r) => s + r.gate.failed, 0),
    },
    waits: (Object.keys(WAIT_LABELS) as WaitKind[])
      .filter((k) => waitTotals.has(k))
      .map((k) => ({ kind: k, label: WAIT_LABELS[k], requirements: waitTotals.get(k)!.length, averageMinutes: avg(waitTotals.get(k)!) ?? 0 })),
    usage: {
      agentMinutes: round1(steps.reduce((s, x) => s + x.minutes, 0)),
      inputTokens: steps.reduce<number | null>((s, x) => add(s, x.inputTokens), null),
      outputTokens: steps.reduce<number | null>((s, x) => add(s, x.outputTokens), null),
      costUsd: steps.reduce<number | null>((s, x) => add(s, x.costUsd), null),
    },
    tokens: tokenBreakdown(steps, done),
    byBuilder: [...builders.entries()].map(([builder, qs]) => ({
      builder,
      requirements: qs.length,
      averageReviewRounds: avg(qs.map((q) => q.reviewRounds)),
      averageCostUsd: avg(qs.flatMap((q) => (q.costUsd === null ? [] : [q.costUsd]))),
    })),
    stops: Object.entries(stopCounts)
      .map(([kind, n]) => ({ kind, label: STOP_LABELS[kind] ?? kind, necessary: NECESSARY_STOPS.includes(kind), runs: n }))
      .sort((a, b) => b.runs - a.runs || a.kind.localeCompare(b.kind)),
    automation: {
      unattendedShare: reachedTesting.length === 0 ? null : Math.round((unattended.length / reachedTesting.length) * 100) / 100,
      recovered,
      interrupted,
      autoRecoveryShare: recoveredTotal + interrupted === 0 ? null : Math.round((recoveredTotal / (recoveredTotal + interrupted)) * 100) / 100,
    },
    byRequester: [...requesters.entries()]
      .map(([requester, qs]) => {
        const finished = qs.filter((q) => done.includes(q));
        return { requester, requirements: qs.length, completed: finished.length, medianCycleHours: median(finished.flatMap((q) => (q.cycleHours === null ? [] : [q.cycleHours]))) };
      })
      .sort((a, b) => b.requirements - a.requirements || a.requester.localeCompare(b.requester)),
    requirements: active,
  };
}

const TYPE_LABELS: Record<string, string> = { normal: "普通", defect: "缺陷", refactor: "重构", assessment: "评估" };
const OUTCOME_LABELS: Record<string, string> = {
  completed: "已完成",
  completed_with_issues: "已完成，有遗留问题",
  not_completed: "未完成",
  unknown: "结论未记录",
};
const STATUS_LABELS: Record<string, string> = {
  completed: "已完成",
  phase_done: "研发完成，待测试验证",
  waiting_for_approval: "等待确认方案",
  waiting_for_business: "等待需求方决定",
  failed: "已中断",
  running: "已中断",
};

function hours(minutes: number): string {
  return minutes < 60 ? `${Math.round(minutes)} 分钟` : `${round1(minutes / 60)} 小时`;
}

function tokens(n: number | null): string {
  if (n === null) return "未报告";
  return n >= 10_000 ? `${round1(n / 10_000)} 万` : String(n);
}

function list(m: Record<string, number>, labels: Record<string, string>): string {
  const order = Object.keys(labels);
  const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
  const entries = Object.entries(m).sort((a, b) => rank(a[0]) - rank(b[0]));
  return entries.length === 0 ? "无" : entries.map(([k, v]) => `${labels[k] ?? k} ${v}`).join("，");
}

/** The summary as a Markdown report for people (management included). */
export function describeStats(s: StatsSummary): string {
  const lines = [`# req-kit 使用情况：${s.period.label}`, ""];
  if (s.active === 0) {
    lines.push("这段时间没有流水线运行记录。");
    return lines.join("\n");
  }
  lines.push(
    `- 机器：${s.machines.join("、")}`,
    `- 有进展的需求：${s.active} 个（${list(s.byType, TYPE_LABELS)}）`,
    `- 完成：${s.completed.total} 个（${list(s.completed.byOutcome, OUTCOME_LABELS)}）`,
    s.cycleHours.median !== null ? `- 交付周期（首次开始到完成）：中位数 ${s.cycleHours.median} 小时，平均 ${s.cycleHours.average} 小时` : "- 交付周期：这段时间没有完成的需求",
    `- agent 合计用时：${hours(s.usage.agentMinutes)}；输入 ${tokens(s.usage.inputTokens)} tokens，输出 ${tokens(s.usage.outputTokens)} tokens${s.usage.costUsd !== null ? `，约 $${s.usage.costUsd.toFixed(2)}` : ""}`,
  );
  const t = s.tokens;
  if (t.total) {
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    lines.push("", "## token 花在哪", "", `- 合计 ${tokens(t.total)} tokens（输入 + 输出）${t.cachedShare !== null ? `；输入中 ${pct(t.cachedShare)} 来自提示缓存` : ""}`);
    if (t.rework) lines.push(`- 返工（方案修订、评审问题修复、缺陷修复、复验，以及第 2 轮起的审核和评审）：${tokens(t.rework.tokens)}，占 ${pct(t.rework.share)}`);
    if (t.perRequirement.median !== null) {
      lines.push(
        `- 每个完成的需求：中位数 ${tokens(t.perRequirement.median)}${t.perRequirement.byProfile.length > 1 ? `（${t.perRequirement.byProfile.map((p) => `${p.profile === "quick" ? "快速档" : p.profile === "standard" ? "标准档" : p.profile} ${tokens(p.median)}，${p.requirements} 个`).join("；")}）` : ""}`,
      );
    }
    lines.push("", "| 步骤 | 次数 | tokens | 占比 |", "| --- | --- | --- | --- |");
    for (const r of t.byStep) lines.push(`| ${r.title} | ${r.steps} | ${tokens(r.tokens)} | ${pct(r.share)} |`);
    if (t.byAgent.length > 1 || t.byAgent[0]?.agent !== "（未记录）") {
      lines.push("", "| 模型 | 步骤数 | tokens | 占比 |", "| --- | --- | --- | --- |");
      for (const r of t.byAgent) lines.push(`| ${r.agent} | ${r.steps} | ${tokens(r.tokens)} | ${pct(r.share)} |`);
    }
  }
  lines.push(
    "",
    "## 返工",
    "",
    `- 平均代码评审轮数（已完成的需求）：${s.rework.averageReviewRounds ?? "无数据"}`,
    `- 需要缺陷修复的需求占比：${s.rework.withDefectRounds === null ? "无数据" : `${Math.round(s.rework.withDefectRounds * 100)}%`}`,
    `- 质量门：运行 ${s.rework.gateRuns} 次，其中发现新失败 ${s.rework.gateFailed} 次`,
  );
  const RECOVERY_LABELS: Record<string, string> = {
    retry: "临时错误重试",
    reattach: "接着等还在做的 agent",
    reuse_result: "沿用旧 agent 的结果",
    extend_timeout: "超时后多等一轮",
    stop_scan: "打断大目录搜索",
    redo: "新开 agent 重做",
    fallback: "换备用模型",
    auto_resume: "自动继续",
    quota_wait: "等额度恢复后继续",
  };
  lines.push(
    "",
    "## 人工介入",
    "",
    `- 到达提测（或完成）的需求中，除了确认方案外没有停下等人的：${s.automation.unattendedShare === null ? "无数据" : `${Math.round(s.automation.unattendedShare * 100)}%`}`,
    `- 自动处理的问题 ${Object.values(s.automation.recovered).reduce((a, b) => a + b, 0)} 次（${list(s.automation.recovered, RECOVERY_LABELS)}），中断等人 ${s.automation.interrupted} 次${s.automation.autoRecoveryShare === null ? "" : `，自动处理的比例 ${Math.round(s.automation.autoRecoveryShare * 100)}%`}`,
  );
  if (s.stops.length > 0) {
    lines.push("", "| 停下等人的原因 | 次数 | 必要的决定 |", "| --- | --- | --- |");
    for (const st of s.stops) lines.push(`| ${st.label} | ${st.runs} | ${st.necessary ? "是" : "否"} |`);
  }
  if (s.waits.length > 0) {
    lines.push("", "## 等待", "", "| 等待 | 需求数 | 平均 |", "| --- | --- | --- |");
    for (const w of s.waits) lines.push(`| ${w.label} | ${w.requirements} | ${hours(w.averageMinutes)} |`);
  }
  lines.push("", "## 各步骤用时", "", "| 步骤 | 次数 | 平均 | 合计 |", "| --- | --- | --- | --- |");
  for (const st of s.steps) lines.push(`| ${st.title} | ${st.count} | ${hours(st.averageMinutes)} | ${hours(st.totalMinutes)} |`);
  if (s.byBuilder.length > 1) {
    lines.push("", "## 按 builder 比较（已完成的需求）", "", "| builder | 需求数 | 平均评审轮数 | 平均费用 |", "| --- | --- | --- | --- |");
    for (const b of s.byBuilder) lines.push(`| ${b.builder} | ${b.requirements} | ${b.averageReviewRounds ?? "-"} | ${b.averageCostUsd === null ? "-" : `$${b.averageCostUsd.toFixed(2)}`} |`);
  }
  if (s.byRequester.length > 0) {
    lines.push("", "## 从卡片开始的需求（按需求方）", "", "| 需求方 | 需求数 | 已完成 | 周期中位数 |", "| --- | --- | --- | --- |");
    for (const r of s.byRequester) lines.push(`| ${r.requester} | ${r.requirements} | ${r.completed} | ${r.medianCycleHours === null ? "-" : `${r.medianCycleHours} 小时`} |`);
  }
  lines.push("", "## 需求", "", "| 项目 | 需求 | 类型 | 状态 | 周期 | agent 用时 | 评审轮数 | 缺陷轮数 |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const q of s.requirements) {
    const status = q.status === "completed" ? (OUTCOME_LABELS[q.outcome ?? "unknown"] ?? "已完成") : (STATUS_LABELS[q.status] ?? q.status);
    lines.push(
      `| ${q.project} | ${q.title.replace(/\|/g, "／")} | ${TYPE_LABELS[q.type ?? "normal"] ?? q.type} | ${status} | ${q.cycleHours === null ? "-" : `${q.cycleHours} 小时`} | ${hours(q.agentMinutes)} | ${q.reviewRounds} | ${q.defectRounds} |`,
    );
  }
  return lines.join("\n");
}

const CSV_COLUMNS: Array<[string, (q: RequirementStats) => unknown]> = [
  ["project", (q) => q.project],
  ["name", (q) => q.name],
  ["title", (q) => q.title],
  ["type", (q) => q.type ?? "normal"],
  ["profile", (q) => q.profile],
  ["machines", (q) => q.machines.join(" ")],
  ["runs", (q) => q.runs],
  ["first_started_at", (q) => q.firstStartedAt],
  ["last_ended_at", (q) => q.lastEndedAt],
  ["status", (q) => q.status],
  ["outcome", (q) => q.outcome ?? ""],
  ["cycle_hours", (q) => q.cycleHours ?? ""],
  ["agent_minutes", (q) => q.agentMinutes],
  ["input_tokens", (q) => q.inputTokens ?? ""],
  ["output_tokens", (q) => q.outputTokens ?? ""],
  ["cost_usd", (q) => q.costUsd ?? ""],
  ["review_rounds", (q) => q.reviewRounds],
  ["defect_rounds", (q) => q.defectRounds],
  ["gate_runs", (q) => q.gateRuns],
  ["gate_failed", (q) => q.gateFailed],
  ["wait_approval_minutes", (q) => q.waits.approval],
  ["wait_business_minutes", (q) => q.waits.business],
  ["wait_verify_minutes", (q) => q.waits.verify],
  ["builder", (q) => q.builder ?? ""],
  ["reviewer", (q) => q.reviewer ?? ""],
  ["requester", (q) => q.requester ?? ""],
  ["card", (q) => q.card ?? ""],
];

function csvCell(v: unknown): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per requirement; UTF-8 with a BOM so spreadsheet programs read the Chinese right. */
export function statsCsv(s: StatsSummary): string {
  const rows = [CSV_COLUMNS.map(([name]) => name).join(",")];
  for (const q of s.requirements) rows.push(CSV_COLUMNS.map(([, get]) => csvCell(get(q))).join(","));
  return `﻿${rows.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// CLI

interface StatsArgs {
  since: string | null;
  month: string | null;
  json: boolean;
  csv: boolean;
  report: boolean;
  out: string | null;
  export: string | true | null;
  merge: string[];
}

export function parseStatsArgs(argv: string[]): StatsArgs {
  const a: StatsArgs = { since: null, month: null, json: false, csv: false, report: false, out: null, export: null, merge: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} 后面要写值`);
      i++;
      return v;
    };
    if (arg === "--since") a.since = value();
    else if (arg === "--month") a.month = value();
    else if (arg === "--json") a.json = true;
    else if (arg === "--csv") a.csv = true;
    else if (arg === "--report") a.report = true;
    else if (arg === "--out") a.out = value();
    else if (arg === "--export") {
      const next = argv[i + 1];
      a.export = next && !next.startsWith("--") ? argv[++i] : true;
    } else if (arg === "--merge") {
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) a.merge.push(argv[++i]);
      if (a.merge.length === 0) throw new Error("--merge 后面要写导出的文件");
    } else throw new Error(`不认识的选项：${arg}`);
  }
  return a;
}

function stamp(d = new Date()): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

export function statsMain(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): number {
  const a = parseStatsArgs(argv);
  const period = parsePeriod({ since: a.since, month: a.month });
  const sources = a.merge.length > 0 ? a.merge.map((f) => path.resolve(cwd, f)) : [runsFile(env)];
  // This machine may have no records yet (nothing ran since 1.9): an empty summary. Named files must exist.
  if (a.merge.length > 0) for (const f of sources) if (!fs.existsSync(f)) throw new Error(`没有这个文件：${f}`);
  const runs = sources.flatMap((f) => readRuns(f));

  if (a.export) {
    const picked = dedupe(runs).filter((r) => inPeriod(r.run.endedAt, period));
    const file = path.resolve(cwd, a.export === true ? `req-kit-usage-${os.hostname()}-${stamp()}.jsonl` : a.export);
    fs.writeFileSync(file, picked.map((r) => JSON.stringify(r)).join("\n") + (picked.length ? "\n" : ""));
    console.log(`已导出 ${picked.length} 条运行记录（${period.label}）：${file}\n汇总多台机器：req stats --merge <各机器导出的文件> --report`);
    return 0;
  }

  const summary = summarizeRuns(runs, period);
  if (a.report) {
    const dir = path.resolve(cwd, a.out ?? ".");
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, `req-kit-usage-${a.month ?? stamp()}`);
    fs.writeFileSync(`${base}.md`, `${describeStats(summary)}\n`);
    fs.writeFileSync(`${base}.csv`, statsCsv(summary));
    console.log(`已生成：\n  ${base}.md（汇报用的汇总）\n  ${base}.csv（每个需求一行，可以用表格软件打开）`);
    return 0;
  }
  if (a.json) console.log(JSON.stringify(summary, null, 2));
  else if (a.csv) process.stdout.write(statsCsv(summary));
  else console.log(describeStats(summary));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    process.exit(statsMain(process.argv.slice(2)));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
}
