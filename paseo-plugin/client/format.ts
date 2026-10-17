// Plain-language labels, shared by every screen.
import type { Attention, Requirement } from "../shared/contracts";

export const ATTENTION_LABELS: Record<Exclude<Attention, null>, string> = {
  approval: "等待确认方案",
  business: "等待需求方决定",
  interrupted: "已中断，可以继续",
  not_completed: "结束但未完成",
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
): Array<"approve" | "stop" | "resume" | "verify" | "sync"> {
  const base: Array<"approve" | "stop" | "resume" | "verify" | "sync"> = r.running
    ? ["stop"]
    : r.attention === "approval"
      ? ["approve"]
      : r.attention === "interrupted" || r.attention === "business"
        ? ["resume"]
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
  resume: { label: "继续", confirm: "从中断处继续？需求说明改过的话，只处理变化的部分。" },
  verify: { label: "开始测试验证", confirm: "开始测试验证？选择在哪里验证。" },
  sync: { label: "同步到外部系统", confirm: "把这个需求同步到对接的外部系统：补发没有成功的调用、补建卡片、更新状态。" },
  reply: { label: "发送回复", confirm: "把回复转给这个需求的对话，由它更新需求说明并继续开发。" },
} as const;
