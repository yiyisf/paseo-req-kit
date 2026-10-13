import fs from "node:fs";
import path from "node:path";

// Prompt sources, from least to most specific:
//   <kit>/engine/prompts/<file>                    shipped with this version
//   <kit home>/prompts.local/<file>                machine-wide override; replaces the shipped file, survives upgrades
//   <kit>/principles/INDEX.md                      principles, also read by the chat skills
//   <repo>/.requirement-pipeline/project-notes.md  appended to every step of this project
//   <repo>/.requirement-pipeline/verify.md         appended to the steps that build, start or test the project
//   <repo>/.requirement-pipeline/steps/<step>.md   appended to one step of this project

export const PROJECT_DIR = ".requirement-pipeline";

export interface PromptLocations {
  promptsDir: string;
  localPromptsDir: string;
  principlesFile: string;
}

export interface PromptSources extends PromptLocations {
  repo: string;
}

export function readToolPrompt(sources: PromptSources, file: string): string {
  const local = path.join(sources.localPromptsDir, file);
  const shipped = path.join(sources.promptsDir, file);
  return fs.readFileSync(fs.existsSync(local) ? local : shipped, "utf8").trim();
}

/** The shared principles, as a prompt section, or null when the index is missing. */
export function principlesSection(sources: PromptSources): string | null {
  const text = readIfPresent(sources.principlesFile);
  if (!text) return null;
  // The index starts with its own title; give it a heading that fits inside the prompt.
  const body = text.replace(/^#\s+.*\n+/, "");
  return ["# 工作原则", "", "以下原则在需求对齐阶段和流水线各步骤中通用。具体要求以前文和\"本步骤任务\"为准，这里说明背后的取舍。", "", body].join("\n");
}

function readIfPresent(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8").trim();
  return text === "" ? null : text;
}

/** Steps that build, start or test the project, and so need the project's verification instructions. */
export const VERIFY_STEPS: readonly string[] = ["implement", "review_fix", "service_start", "verify", "defect_fix", "reverify"];

/** Project-specific additions for one step, ready to append, or null when there are none. */
export function projectAdditions(sources: PromptSources, stepId: string): string | null {
  const notes = readIfPresent(path.join(sources.repo, PROJECT_DIR, "project-notes.md"));
  const verify = VERIFY_STEPS.includes(stepId) ? readIfPresent(path.join(sources.repo, PROJECT_DIR, "verify.md")) : null;
  const step = readIfPresent(path.join(sources.repo, PROJECT_DIR, "steps", `${stepId}.md`));
  if (!notes && !verify && !step) return null;
  const parts = [
    "# 本项目的补充说明",
    "",
    "以下内容由项目维护者编写，说明这个项目的约定和要求。与前文的通用要求冲突时，以这里为准；但\"如实报告\"和安全方面的要求始终有效。",
  ];
  if (notes) parts.push("", notes);
  if (verify) {
    parts.push(
      "",
      "## 本项目的验证方法",
      "",
      "来自 `.requirement-pipeline/verify.md`，其中的命令已由项目维护者实际运行过。安装依赖、启动服务、运行测试时优先照此执行；发现它过时或不准确时，照常完成本步骤，并在你的产物里写明哪里不对、实际可行的做法是什么。",
      "",
      verify,
    );
  }
  if (step) parts.push("", "## 针对本步骤", "", step);
  return parts.join("\n");
}
