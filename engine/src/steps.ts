import type { AgentRole } from "./runtime.js";

export type StepId =
  | "design"
  | "design_review"
  | "design_revise"
  | "implement"
  | "code_review"
  | "review_fix"
  | "service_start"
  | "verify"
  | "defect_fix"
  | "reverify"
  | "report"
  /** One member of the optional review panel; runs before design_review / code_review consolidates. */
  | "panel_review"
  /** Independent review of a draft spec before the requester confirms it (run from the chat, not the pipeline). */
  | "spec_review"
  /** One of the parallel design proposals that the design step compares (optional). */
  | "design_proposal";

type FieldSpec =
  | { kind: "boolean" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "string" }
  | { kind: "string[]" };

export interface ResultSpec {
  required: Record<string, FieldSpec>;
  optional?: Record<string, FieldSpec>;
  /** Extra cross-field rule; returns an error message or null. */
  check?: (value: Record<string, unknown>) => string | null;
}

export interface StepDef {
  id: StepId;
  /** Step number in the 11-step list the user defined. */
  number: number;
  title: string;
  role: AgentRole;
  promptFile: string;
  result: ResultSpec;
}

const done: ResultSpec = { required: { status: { kind: "enum", values: ["done", "partial"] } } };

/** Review steps that can run with a review panel. */
export const PANEL_STEPS = ["design_review", "code_review"] as const;
export type PanelStep = (typeof PANEL_STEPS)[number];

export const STEPS: Record<StepId, StepDef> = {
  spec_review: {
    id: "spec_review",
    number: 2,
    title: "需求说明审阅",
    role: "reviewer",
    promptFile: "02-spec-review.md",
    result: {
      required: { verdict: { kind: "enum", values: ["ready", "issues"] } },
      optional: { issues: { kind: "string[]" } },
      check: (value) =>
        value.verdict === "issues" && (!Array.isArray(value.issues) || value.issues.length === 0)
          ? "verdict 为 issues 时，issues 必须是非空的字符串数组（每条一句话）"
          : null,
    },
  },
  design_proposal: {
    id: "design_proposal",
    number: 3,
    title: "方案提案",
    role: "builder",
    promptFile: "03a-design-proposal.md",
    result: done,
  },
  panel_review: {
    id: "panel_review",
    number: 0,
    title: "评审小组成员",
    role: "reviewer",
    promptFile: "panel-member.md",
    result: done,
  },
  design: {
    id: "design",
    number: 3,
    title: "方案设计",
    role: "builder",
    promptFile: "03-design.md",
    result: { required: { has_runnable_service: { kind: "boolean" } } },
  },
  design_review: {
    id: "design_review",
    number: 4,
    title: "方案审核",
    role: "reviewer",
    promptFile: "04-design-review.md",
    result: {
      required: { verdict: { kind: "enum", values: ["approved", "changes_required", "blocked"] } },
      optional: { questions: { kind: "string[]" } },
      check: (value) =>
        value.verdict === "blocked" && (!Array.isArray(value.questions) || value.questions.length === 0)
          ? "verdict 为 blocked 时，questions 必须是非空的字符串数组"
          : null,
    },
  },
  design_revise: {
    id: "design_revise",
    number: 4,
    title: "方案修订",
    role: "builder",
    promptFile: "04b-design-revise.md",
    result: done,
  },
  implement: {
    id: "implement",
    number: 5,
    title: "代码实现",
    role: "builder",
    promptFile: "05-implement.md",
    result: done,
  },
  code_review: {
    id: "code_review",
    number: 6,
    title: "代码评审",
    role: "reviewer",
    promptFile: "06-code-review.md",
    result: { required: { verdict: { kind: "enum", values: ["pass", "changes_required"] } } },
  },
  review_fix: {
    id: "review_fix",
    number: 7,
    title: "评审问题修复",
    role: "builder",
    promptFile: "07-review-fix.md",
    result: done,
  },
  service_start: {
    id: "service_start",
    number: 8,
    title: "服务启动验证",
    role: "builder",
    promptFile: "08-service-start.md",
    result: { required: { started: { kind: "boolean" } } },
  },
  verify: {
    id: "verify",
    number: 9,
    title: "功能验证",
    role: "reviewer",
    promptFile: "09-verify.md",
    result: { required: { result: { kind: "enum", values: ["pass", "defects_found", "blocked"] } } },
  },
  defect_fix: {
    id: "defect_fix",
    number: 10,
    title: "缺陷修复",
    role: "builder",
    promptFile: "10-defect-fix.md",
    result: done,
  },
  reverify: {
    id: "reverify",
    number: 10,
    title: "复验",
    role: "reviewer",
    promptFile: "10b-reverify.md",
    result: { required: { result: { kind: "enum", values: ["pass", "defects_remaining"] } } },
  },
  report: {
    id: "report",
    number: 11,
    title: "完成报告",
    role: "builder",
    promptFile: "11-report.md",
    result: {
      required: {
        outcome: { kind: "enum", values: ["completed", "completed_with_issues", "not_completed"] },
        summary: { kind: "string" },
      },
    },
  },
};

function checkField(name: string, spec: FieldSpec, value: unknown): string | null {
  switch (spec.kind) {
    case "boolean":
      return typeof value === "boolean" ? null : `${name} 必须是 true 或 false`;
    case "string":
      return typeof value === "string" && value.trim() !== "" ? null : `${name} 必须是非空字符串`;
    case "string[]":
      return Array.isArray(value) && value.every((item) => typeof item === "string")
        ? null
        : `${name} 必须是字符串数组`;
    case "enum":
      return typeof value === "string" && spec.values.includes(value)
        ? null
        : `${name} 必须是 ${spec.values.map((v) => `"${v}"`).join(" / ")} 之一`;
  }
}

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export function validateResult(spec: ResultSpec, raw: unknown): ValidationResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "内容必须是一个 JSON 对象" };
  }
  const value = raw as Record<string, unknown>;
  for (const [name, field] of Object.entries(spec.required)) {
    if (!(name in value)) return { ok: false, error: `缺少字段 ${name}` };
    const error = checkField(name, field, value[name]);
    if (error) return { ok: false, error };
  }
  for (const [name, field] of Object.entries(spec.optional ?? {})) {
    if (name in value && value[name] !== undefined) {
      const error = checkField(name, field, value[name]);
      if (error) return { ok: false, error };
    }
  }
  const crossError = spec.check?.(value) ?? null;
  if (crossError) return { ok: false, error: crossError };
  return { ok: true, value };
}

export function stepKey(id: StepId, round: number | null): string {
  return round === null ? id : `${id}-r${round}`;
}
