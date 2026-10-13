import fs from "node:fs";
import path from "node:path";

// Prompt sources, from least to most specific:
//   <tool>/prompts/<file>                          shipped with the tool
//   <tool>/prompts.local/<file>                    machine-wide override; replaces the shipped file, survives upgrades
//   <repo>/.requirement-pipeline/project-notes.md  appended to every step of this project
//   <repo>/.requirement-pipeline/steps/<step>.md   appended to one step of this project

export const PROJECT_DIR = ".requirement-pipeline";

export interface PromptSources {
  toolDir: string;
  repo: string;
}

export function readToolPrompt(sources: PromptSources, file: string): string {
  const local = path.join(sources.toolDir, "prompts.local", file);
  const shipped = path.join(sources.toolDir, "prompts", file);
  return fs.readFileSync(fs.existsSync(local) ? local : shipped, "utf8").trim();
}

function readIfPresent(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8").trim();
  return text === "" ? null : text;
}

/** Project-specific additions for one step, ready to append, or null when there are none. */
export function projectAdditions(sources: PromptSources, stepId: string): string | null {
  const notes = readIfPresent(path.join(sources.repo, PROJECT_DIR, "project-notes.md"));
  const step = readIfPresent(path.join(sources.repo, PROJECT_DIR, "steps", `${stepId}.md`));
  if (!notes && !step) return null;
  const parts = [
    "# 本项目的补充说明",
    "",
    "以下内容由项目维护者编写，说明这个项目的约定和要求。与前文的通用要求冲突时，以这里为准；但\"如实报告\"和安全方面的要求始终有效。",
  ];
  if (notes) parts.push("", notes);
  if (step) parts.push("", "## 针对本步骤", "", step);
  return parts.join("\n");
}
