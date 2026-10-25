// Plain-language labels, shared by every screen.
import type { Attention, Requirement } from "../shared/contracts";

export const ATTENTION_LABELS: Record<Exclude<Attention, null>, string> = {
  approval: "等待确认方案",
  business: "等待需求方决定",
  permission: "等待批准权限",
  interrupted: "已中断，可以继续",
  not_completed: "结束但未完成",
  not_started: "已确认，未开始开发",
};

export const TYPE_LABELS: Record<string, string> = { defect: "缺陷", refactor: "重构", assessment: "评估" };

export const PROFILE_LABELS: Record<string, string> = { quick: "快速档", standard: "标准档" };

export const FILE_LABELS: Record<string, string> = {
  "spec.md": "需求说明",
  "alignment.md": "访谈记录",
  "spec-review.md": "需求说明审阅",
  "changes.md": "需求变更",
  "decisions.tsv": "决策记录",
  "design.md": "方案",
  "design-review.md": "方案审核",
  "preview.md": "确认预览",
  "contract.md": "接口约定",
  "diagnosis.md": "复现与定位",
  "assessment.md": "评估",
  "implementation.md": "实现记录",
  "progress.md": "进展",
  "code-review.md": "代码评审",
  "handoff.md": "提测说明",
  "service-start.md": "服务启动",
  "verification.md": "功能验证",
  "report.md": "完成报告",
  "acceptance.md": "验收记录",
  "lessons.tsv": "可以变成规则的问题",
};

export type Group = "attention" | "running" | "verify" | "done" | "other";

export const GROUP_LABELS: Record<Group, string> = {
  attention: "需要你处理",
  running: "进行中",
  verify: "研发完成，待测试验证",
  done: "最近完成",
  other: "其他",
};

const RECENT_MS = 14 * 24 * 3600_000;

export function groupOf(r: Requirement, now = Date.now()): Group {
  if (r.attention) return "attention";
  if (r.running) return "running";
  if (r.status === "phase_done") return "verify";
  if (r.status === "completed" && now - Date.parse(r.updatedAt) < RECENT_MS) return "done";
  return "other";
}

export function minutes(m: number): string {
  if (m < 1) return "不到 1 分钟";
  if (m < 60) return `${Math.round(m)} 分钟`;
  const h = Math.floor(m / 60);
  const rest = Math.round(m % 60);
  return rest === 0 ? `${h} 小时` : `${h} 小时 ${rest} 分`;
}

export function ago(iso: string, now = Date.now()): string {
  const m = (now - Date.parse(iso)) / 60_000;
  if (!Number.isFinite(m)) return "";
  if (m < 1) return "刚刚";
  if (m < 60) return `${Math.round(m)} 分钟前`;
  if (m < 24 * 60) return `${Math.round(m / 60)} 小时前`;
  return `${Math.round(m / 60 / 24)} 天前`;
}

export function tokens(n: number | null): string {
  if (n === null) return "未报告";
  return n >= 10_000 ? `${Math.round(n / 1_000) / 10} 万` : String(n);
}

/** One line under a requirement's title: project, type, stage. */
export function facts(r: Requirement): string {
  return [r.project, r.type ? TYPE_LABELS[r.type] ?? r.type : null, r.profile ? PROFILE_LABELS[r.profile] ?? r.profile : null]
    .filter(Boolean)
    .join(" · ");
}

/** What a person can do from here, by the requirement's state. */
export function actionsFor(
  r: Pick<Requirement, "attention" | "running" | "status"> & { external?: Array<{ pending: number; id: string | null }> },
): Array<"approve" | "stop" | "resume" | "verify" | "sync" | "start"> {
  const base: Array<"approve" | "stop" | "resume" | "verify" | "sync" | "start"> = r.running
    ? ["stop"]
    : r.attention === "approval"
      ? ["approve"]
      : r.attention === "interrupted" || r.attention === "business"
        ? ["resume"]
        : r.attention === "not_started"
          ? ["start"]
        : r.status === "phase_done"
          ? ["verify"]
          : [];
  // A running pipeline sends what failed by itself at its next step change.
  if (!r.running && r.status && (r.external ?? []).some((e) => e.pending > 0 || !e.id)) base.push("sync");
  return base;
}

export const ACTION_TEXT = {
  approve: { label: "确认方案", confirm: "确认 preview.md 中的方案，开始写代码？请先看过确认预览和原型。" },
  stop: { label: "停止", confirm: "停止这个需求的流水线？正在运行的步骤会被中断，之后可以继续。" },
  start: { label: "开始开发", confirm: "按已确认的需求说明开始开发？在项目主目录中的需求会新建自己的工作区；进展发回谈需求的那个对话。" },
  resume: { label: "继续", confirm: "从中断处继续？需求说明改过的话，只处理变化的部分。" },
  verify: { label: "开始测试验证", confirm: "开始测试验证？选择在哪里验证。" },
  sync: { label: "同步到外部系统", confirm: "把这个需求同步到对接的外部系统：补发没有成功的调用、补建卡片、更新状态。" },
  reply: { label: "发送回复", confirm: "把回复转给这个需求的对话，由它更新需求说明并继续开发。" },
} as const;

/** The six stops of the step track, and who does each (design/components/StepTrack.md). */
export const TRACK = [
  { label: "对齐", who: "你" },
  { label: "方案", who: "AI · 你确认" },
  { label: "实现", who: "AI" },
  { label: "评审", who: "AI · 开发同事" },
  { label: "验证", who: "AI" },
  { label: "验收", who: "需求方" },
] as const;

const STEP_STOP: Array<[RegExp, number]> = [
  [/^(design|design_review|design_revise|design_proposal|assessment|diagnosis|reproduce)/, 1],
  [/^(implement|acceptance_tests)/, 2],
  [/^(code_review|review_fix)/, 3],
  [/^(verify|defect_fix|reverify|service|handoff|report)/, 4],
];

/**
 * Where the requirement is on the track, and whether that stop waits for a person.
 * `humanReview` (detail only) tells whether the code review is done.
 */
export function trackOf(
  r: Pick<Requirement, "stage" | "status" | "attention" | "running" | "current">,
  humanReview?: { status: string; stale: boolean } | null,
): Array<{ label: string; who: string; state: "done" | "now" | "needs" | "todo" }> {
  let at = 0;
  let needs = false;
  const running = r.current[0]?.key;
  if (r.stage.startsWith("对齐")) at = 0;
  else if (r.attention === "approval" || r.attention === "business" || r.attention === "not_started") [at, needs] = [1, true];
  else if (running) at = STEP_STOP.find(([re]) => re.test(running))?.[1] ?? 2;
  else if (r.status === "phase_done") [at, needs] = [4, true];
  else if (r.status === "completed" || /待验收|已验收|验收/.test(r.stage)) {
    const reviewed = humanReview && humanReview.status === "approved" && !humanReview.stale;
    if (/已验收|验收通过/.test(r.stage)) at = TRACK.length;
    else if (humanReview !== undefined && !reviewed) [at, needs] = [3, true];
    else [at, needs] = [5, true];
  } else if (r.status) at = 2;
  return TRACK.map((t, i) => ({ ...t, state: i < at ? "done" : i === at ? (needs ? "needs" : "now") : "todo" }));
}

/** The icon of a requirement in a list, by what it needs (Lucide names). */
export function iconOf(r: Pick<Requirement, "attention" | "running" | "status" | "stage">): { name: string; tone: "needs" | "running" | "success" | "warning" | "danger" | "muted" } {
  if (r.attention === "interrupted") return { name: "OctagonAlert", tone: "danger" };
  if (r.attention === "permission") return { name: "ShieldCheck", tone: "needs" };
  if (r.attention === "approval") return { name: "PenTool", tone: "needs" };
  if (r.attention === "business") return { name: "MessagesSquare", tone: "needs" };
  if (r.attention === "not_started") return { name: "Play", tone: "needs" };
  if (r.attention === "not_completed") return { name: "CircleDashed", tone: "warning" };
  if (r.running) return { name: "LoaderCircle", tone: "running" };
  if (r.stage.startsWith("对齐")) return { name: "MessagesSquare", tone: "muted" };
  if (r.status === "phase_done" || /待验收/.test(r.stage)) return { name: "ClipboardCheck", tone: "warning" };
  if (r.status === "completed") return { name: "CircleCheck", tone: "success" };
  return { name: "Circle", tone: "muted" };
}
