import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PROFILE_LABELS, PROFILE_NAMES, type ProfileName } from "./config.js";
import { gitInfo } from "./git.js";
import { samePath } from "./paths.js";
import { currentLockHolder, type PipelineState, readState, statePath } from "./state.js";

export interface LaunchArgs {
  repo: string;
  featureDir: string;
  originAgentId: string | null;
  resume: boolean;
  restart: boolean;
  configPath: string | null;
  /** Explicit --profile; otherwise the spec's "档位" line, then the configured default. */
  profile: ProfileName | null;
  status: boolean;
  stop: boolean;
  /** --list: print every requirement in this repository's worktrees. */
  list: boolean;
  /** --spec-review: independent review of the draft spec, before confirmation. */
  specReview: boolean;
  /** --worktree: create a Paseo worktree workspace for this requirement and develop there. */
  worktree: boolean;
  /**
   * The checkout the chat works in, when the pipeline runs in a worktree created for it
   * (repo is then that worktree). Set by the launcher; the chat's cwd must be this.
   */
  sourceRepo: string | null;
  /** Paseo workspace of that worktree. */
  workspaceId: string | null;
  /** --at: schedule the start for later instead of starting now. */
  at: string | null;
}

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

function gitCommonDir(dir: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out ? fs.realpathSync(out) : null;
  } catch {
    return null;
  }
}

/** Whether `worktree` is a git worktree of the same repository as `source`. */
export function sameRepository(worktree: string, source: string): boolean {
  const a = gitCommonDir(worktree);
  const b = gitCommonDir(source);
  return a !== null && b !== null && samePath(a, b);
}

/**
 * Step agents run under the launching chat. Normally they work in the chat's own
 * directory, so the repository must be it. A requirement developed in a worktree
 * created for it (--worktree) runs in that worktree instead; the chat must then be
 * in the checkout the worktree was created from.
 */
export function checkChatCwd(args: Pick<LaunchArgs, "originAgentId" | "sourceRepo">, repo: string, env: NodeJS.ProcessEnv = process.env): void {
  const chatCwd = env.PASEO_AGENT_CWD?.trim();
  if (!args.originAgentId || !chatCwd || env.PASEO_AGENT_ID?.trim() !== args.originAgentId) return;
  const chat = fs.existsSync(chatCwd) ? fs.realpathSync(chatCwd) : chatCwd;
  if (args.sourceRepo) {
    const source = fs.existsSync(args.sourceRepo) ? fs.realpathSync(args.sourceRepo) : args.sourceRepo;
    if (samePath(chat, source) && sameRepository(repo, source)) return;
    throw new PreflightError(
      `这个需求在为它新建的工作区 ${repo} 中开发，只能从 ${source} 的对话中操作，当前对话的工作目录是 ${chatCwd}。`,
    );
  }
  if (!samePath(chat, repo)) {
    throw new PreflightError(
      `仓库目录 ${repo} 与当前对话的工作目录 ${chatCwd} 不一致。` +
        "流水线的步骤会挂在这个对话下、在对话的工作目录中进行，所以只能为对话所在的项目启动。" +
        "请在该仓库对应的项目中打开对话后再启动；对话过程中不要切换工作目录。",
    );
  }
}

/** The spec must carry the line written by the kickoff skill after the user confirms it. */
export function isSpecConfirmed(specText: string): boolean {
  return /^\s*-\s*状态\s*[:：]\s*已确认/m.test(specText);
}

export function normalizeFeatureDir(repo: string, featureDir: string): string {
  const absolute = path.resolve(repo, featureDir);
  const relative = path.relative(repo, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PreflightError(`功能目录必须位于仓库目录之内：${featureDir}`);
  }
  return relative.split(path.sep).join("/");
}

export type StartMode =
  | { kind: "fresh" }
  | { kind: "restart"; previous: PipelineState }
  | { kind: "resume-reuse"; previous: PipelineState }
  | { kind: "resume-from-design"; previous: PipelineState; reason: string };

export interface PreflightResult {
  repo: string;
  featureDir: string;
  specPath: string;
  mode: StartMode;
  /** Branch the run will commit to; null outside a git repository. */
  branch: string | null;
  /** Profile named in the spec, if any. */
  specProfile: ProfileName | null;
}

/** Reads "- 档位：快速" / "- 档位：标准" from the spec header. */
export function specProfile(specText: string): ProfileName | null {
  const match = /^\s*-\s*档位\s*[:：]\s*(\S+)/m.exec(specText);
  if (!match) return null;
  for (const name of PROFILE_NAMES) {
    if (match[1].startsWith(PROFILE_LABELS[name]) || match[1].toLowerCase().startsWith(name)) return name;
  }
  return null;
}

/**
 * Checks everything that can be checked without talking to the daemon.
 * The launcher runs this before detaching so the chat agent gets an immediate,
 * readable error; the pipeline process runs it again before taking the lock.
 */
export function preflight(
  args: LaunchArgs,
  currentSpecHash: (file: string) => string,
  env: NodeJS.ProcessEnv = process.env,
): PreflightResult {
  if (!fs.existsSync(args.repo) || !fs.statSync(args.repo).isDirectory()) {
    throw new PreflightError(`仓库目录不存在：${args.repo}`);
  }
  const repo = fs.realpathSync(args.repo);
  checkChatCwd(args, repo, env);
  const featureDir = normalizeFeatureDir(repo, args.featureDir);
  const featureAbs = path.join(repo, featureDir);
  if (!fs.existsSync(featureAbs) || !fs.statSync(featureAbs).isDirectory()) {
    throw new PreflightError(`功能目录不存在：${featureDir}`);
  }
  const specPath = path.join(featureAbs, "spec.md");
  if (!fs.existsSync(specPath)) {
    throw new PreflightError(`功能目录中没有 spec.md：${featureDir}`);
  }
  const specText = fs.readFileSync(specPath, "utf8");
  if (!isSpecConfirmed(specText)) {
    throw new PreflightError(
      'spec.md 还没有被确认（顶部需要有 "- 状态：已确认" 这一行）。请先和用户确认需求说明。',
    );
  }
  if (args.resume && args.restart) {
    throw new PreflightError("--resume 和 --restart 不能同时使用");
  }

  const holder = currentLockHolder(repo);
  if (holder) {
    throw new PreflightError(
      `这个仓库目录已有一条流水线在运行（进程 ${holder.pid}，功能目录 ${holder.featureDir}）。同一个目录一次只能运行一条。`,
    );
  }

  const previous = readState(statePath(repo, featureDir));
  let mode: StartMode;
  if (!previous) {
    if (args.resume) throw new PreflightError("没有找到之前的运行记录，无法继续。去掉 --resume 重新启动即可。");
    mode = { kind: "fresh" };
  } else if (args.restart) {
    mode = { kind: "restart", previous };
  } else if (!args.resume) {
    const hint =
      previous.status === "completed"
        ? "这个需求的流水线已经完成。如需重新完整运行，请加 --restart。"
        : `这个需求已有运行记录（状态：${previous.status}）。从中断处继续请加 --resume，从头开始请加 --restart。`;
    throw new PreflightError(hint);
  } else if (previous.status === "completed") {
    // A completed requirement is reopened by changing its spec (a requirement change, or
    // problems found during acceptance). Without such a change there is nothing to continue.
    if (currentSpecHash(specPath) === previous.specHash) {
      throw new PreflightError(
        "这个需求的流水线已经完成，没有可继续的步骤。要修改需求或修复验收中发现的问题，请先更新并重新确认 spec.md；要原样重跑一遍，请用 --restart。",
      );
    }
    mode = { kind: "resume-from-design", previous, reason: "流水线完成后 spec.md 被修改过（需求变更或验收发现的问题），从方案设计开始增量处理" };
  } else if (previous.status === "waiting_for_business") {
    mode = { kind: "resume-from-design", previous, reason: "上次因等待需求方决定而停止，需求可能已更新，从方案设计开始增量处理" };
  } else if (currentSpecHash(specPath) !== previous.specHash) {
    mode = { kind: "resume-from-design", previous, reason: "spec.md 在上次运行后被修改过，从方案设计开始增量处理" };
  } else {
    // "failed", or "running" left behind by a process that died without cleanup.
    mode = { kind: "resume-reuse", previous };
  }
  const git = gitInfo(repo);
  if (args.worktree) {
    // The run will happen in a new worktree on its own branch, cut from what is checked out here.
    if (mode.kind !== "fresh") {
      throw new PreflightError("这个需求已经在这里运行过，不能再改为在新工作区中开发。请用 --resume 继续，或去掉 --worktree。");
    }
    if (!git.isRepo) throw new PreflightError("--worktree 需要 git 仓库。");
    return { repo, featureDir, specPath, mode, branch: git.branch, specProfile: specProfile(specText) };
  }
  // The run commits to the branch that is checked out now, and never to the default branch.
  if (git.isRepo && git.detached) {
    throw new PreflightError("当前没有处在任何分支上（detached HEAD）。请切换到这个需求的工作分支后再启动。");
  }
  if (git.branch && git.protectedBranches.includes(git.branch)) {
    throw new PreflightError(
      `当前在默认分支 ${git.branch} 上，流水线不会在默认分支上提交代码。` +
        "可以加 --worktree，让流水线为这个需求新建一个 worktree 工作区并在那里开发（这个对话不用动）；" +
        "或者在 Paseo 中自己新建一个 worktree 工作区（New workspace → Isolation 选 New worktree），在那里的对话中重新开始；" +
        "或者先切换到这个需求的功能分支。",
    );
  }
  if (mode.kind === "resume-reuse" && mode.previous.branch && git.branch !== mode.previous.branch) {
    throw new PreflightError(
      `这个需求之前在分支 ${mode.previous.branch} 上进行，现在的分支是 ${git.branch ?? "（无）"}。请切回原分支后继续，或用 --restart 在当前分支上从头开始。`,
    );
  }
  return { repo, featureDir, specPath, mode, branch: git.branch, specProfile: specProfile(specText) };
}
