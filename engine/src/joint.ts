// Joint requirements (ADR 0025): one requirement that also changes other repositories
// (e.g. the backend of a frontend project). The run in the chat's repository coordinates:
// it designs the whole change and the interface contract, then each other repository gets
// a Paseo worktree on the requirement's branch where its own implementation, code review
// and fixes run (in parallel with this repository's); handoff, verification and the report
// stay here. Everything is committed locally only.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type CheckDef, type RelatedRepo, resolveRelatedRepo } from "./config.js";
import type { AgentRuntime } from "./runtime.js";
import { ensurePipelineDir, hashFile, type JointRepo, type PipelineState } from "./state.js";

/** At most this many other repositories in one requirement (three in all). */
export const MAX_JOINT = 2;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Where a step runs: this repository (no target) or one of the joint repositories. */
export interface StepTarget {
  name: string;
  slug: string;
  repo: string;
  featureDir: string;
  workspaceId: string | null;
  branch: string | null;
  joint: JointRepo;
}

/** An ASCII suffix for step keys, from the repository's directory name. */
export function slugFor(dir: string, taken: string[]): string {
  const base = path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "repo";
  let slug = base;
  for (let i = 2; taken.includes(slug); i++) slug = `${base}-${i}`;
  return slug;
}

/** Problems with the spec's "联合开发" names for this configuration, or null. */
export function jointProblem(names: string[], related: RelatedRepo[], projectDir: string): string | null {
  if (names.length === 0) return null;
  if (names.length > MAX_JOINT) return `联合开发最多再涉及 ${MAX_JOINT} 个仓库（一共 ${MAX_JOINT + 1} 个），需求说明里写了 ${names.length} 个：${names.join("、")}`;
  for (const name of names) {
    const r = related.find((x) => x.name === name);
    if (!r) {
      return `需求说明的"联合开发"中有「${name}」，但项目配置的 relatedRepos 里没有登记这个仓库${related.length > 0 ? `（已登记：${related.map((x) => x.name).join("、")}）` : ""}。请在 .requirement-pipeline.json 中登记，或改正需求说明`;
    }
    const dir = resolveRelatedRepo(r, projectDir);
    if (!fs.existsSync(dir)) return `联合开发的仓库「${name}」不在这台机器上：${dir}`;
    try {
      git(dir, "rev-parse", "--git-dir");
    } catch {
      return `联合开发的仓库「${name}」不是 git 仓库：${dir}`;
    }
  }
  return null;
}

/** The joint repositories this run works in: those the spec names now, in that order. */
export function activeJoint(state: Pick<PipelineState, "joint">, names: string[]): JointRepo[] {
  return names.map((n) => (state.joint ?? []).find((j) => j.name === n)).filter((j): j is JointRepo => j !== undefined);
}

/**
 * Creates the worktree of each named repository that does not have one yet, on the branch
 * feature/<requirement>, cut from what that repository has checked out. Returns the entries.
 */
export async function ensureJointRepos(input: {
  runtime: Pick<AgentRuntime, "createWorktree">;
  state: PipelineState;
  featureDir: string;
  names: string[];
  related: RelatedRepo[];
  projectDir: string;
  title: string;
  log: (message: string) => void;
}): Promise<JointRepo[]> {
  const { state } = input;
  state.joint ??= [];
  for (const name of input.names) {
    if (state.joint.some((j) => j.name === name)) continue;
    const r = input.related.find((x) => x.name === name);
    if (!r) throw new Error(`联合开发的仓库「${name}」没有在 relatedRepos 中登记`);
    const sourceRepo = fs.realpathSync(resolveRelatedRepo(r, input.projectDir));
    const branch = `feature/${path.basename(input.featureDir)}`;
    let exists = true;
    try {
      git(sourceRepo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
    } catch {
      exists = false;
    }
    if (exists) {
      throw new Error(`联合开发的仓库「${name}」（${sourceRepo}）里已经有分支 ${branch}。可能是之前开始过这个需求：请在那个仓库确认后删除或改名这个分支，再继续`);
    }
    const head = git(sourceRepo, "rev-parse", "--abbrev-ref", "HEAD");
    const baseRef = head === "HEAD" ? git(sourceRepo, "rev-parse", "HEAD") : head;
    const created = await input.runtime.createWorktree({
      sourceRepo,
      baseRef,
      branchName: branch,
      title: `${input.title}（${name}）`,
      callerAgentId: state.originAgentId,
    });
    const repo = fs.realpathSync(created.directory);
    ensurePipelineDir(repo, input.featureDir);
    const entry: JointRepo = {
      name,
      slug: slugFor(sourceRepo, state.joint.map((j) => j.slug)),
      sourceRepo,
      repo,
      workspaceId: created.workspaceId,
      branch,
      specHash: null,
    };
    state.joint.push(entry);
    input.log(`联合开发：为「${name}」新建了工作区 ${repo}（分支 ${branch}，从 ${baseRef} 切出）`);
  }
  return activeJoint(state, input.names);
}

/**
 * Copies the requirement's documents (spec, design, contract, preview) from this repository's
 * feature directory into each joint repository's, and commits them there when they changed,
 * so whoever reviews and merges that repository reads them next to its code.
 */
export function syncJointDocs(entries: JointRepo[], mainRepo: string, featureDir: string, files: string[], title: string, log: (message: string) => void): void {
  const from = path.join(mainRepo, featureDir);
  for (const entry of entries) {
    const to = path.join(entry.repo, featureDir);
    fs.mkdirSync(to, { recursive: true });
    ensurePipelineDir(entry.repo, featureDir);
    const copied: string[] = [];
    for (const file of files) {
      const src = path.join(from, file);
      if (!fs.existsSync(src)) continue;
      fs.cpSync(src, path.join(to, file), { recursive: true });
      copied.push(path.join(featureDir, file));
    }
    const spec = path.join(from, "spec.md");
    if (fs.existsSync(spec)) entry.specHash = hashFile(spec);
    if (copied.length === 0) continue;
    try {
      git(entry.repo, "add", "--", ...copied);
      if (git(entry.repo, "diff", "--cached", "--name-only", "--", ...copied)) {
        git(entry.repo, "commit", "-q", "-m", `docs(req): ${title} 的需求说明和方案（同步自主仓库）`, "--", ...copied);
        log(`联合开发：已把 ${files.filter((f) => fs.existsSync(path.join(from, f))).join("、")} 同步到「${entry.name}」并提交`);
      }
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim();
      log(`联合开发：同步到「${entry.name}」后提交失败（${stderr || (error as Error).message}），文件已复制，步骤照常可以读到`);
    }
  }
}

/** The quality-gate checks a joint repository defines in its own project configuration. */
export function loadProjectChecks(repo: string, log: (message: string) => void): CheckDef[] {
  const file = path.join(repo, ".requirement-pipeline.json");
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { checks?: unknown };
    if (!Array.isArray(raw.checks)) return [];
    const checks = raw.checks.filter(
      (c): c is CheckDef => typeof c === "object" && c !== null && typeof (c as CheckDef).name === "string" && typeof (c as CheckDef).command === "string",
    );
    if (checks.length !== raw.checks.length) log(`${file} 中有写法不对的检查，已跳过`);
    return checks;
  } catch (error) {
    log(`读不了 ${file}：${(error as Error).message}，这个仓库不运行质量门`);
    return [];
  }
}
