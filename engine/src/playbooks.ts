// Requirement types with their own playbook (spec "- 类型："). A playbook keeps the
// pipeline's steps but changes what some of them do, through a prompt file with one
// section per step, and the flow skips what the type does not need. See ADR 0023.
//
//   缺陷 (defect)       design becomes "reproduce and locate": a failing reproduction first;
//                        cannot reproduce → stop and ask. The fix must turn it green.
//   重构 (refactor)     behavior is locked first (characterization tests), then small steps,
//                        each keeping every check green; review checks that behavior did not change.
//   评估 (assessment)   read-only: research → assessment.md → independent review → report. No code.

import type { RequirementType } from "./config.js";
import { type PromptSources, readToolPrompt } from "./prompts.js";
import { STEPS, type StepId } from "./steps.js";

const TITLES: Record<RequirementType, Partial<Record<StepId, string>>> = {
  defect: { design: "复现与定位" },
  refactor: { design: "方案设计与行为锁定" },
  assessment: { design: "调研评估", design_review: "评估审阅", design_revise: "评估修订", report: "评估报告" },
};

/** The step's title for this requirement type. */
export function stepTitle(type: RequirementType | null | undefined, id: StepId): string {
  return (type && TITLES[type][id]) || STEPS[id].title;
}

/**
 * The playbook's guidance for one step: the "## 所有步骤" section plus the section whose
 * heading names the step id in parentheses, e.g. "## 代码实现（implement）". Null when the
 * playbook has nothing for this step.
 */
export function playbookSection(sources: PromptSources, type: RequirementType, id: StepId): string | null {
  const text = readToolPrompt(sources, `types/${type}.md`);
  const [intro, ...sections] = text.split(/^## /m);
  const picked = sections.filter((s) => {
    const heading = s.split("\n", 1)[0];
    return heading.startsWith("所有步骤") || heading.includes(`（${id}）`) || heading.includes(`(${id})`);
  });
  // The common part alone is still worth giving: the type changes what every step looks for.
  if (picked.length === 0) return null;
  return [intro.trim(), ...picked.map((s) => `## ${s.trim()}`)].join("\n\n");
}
