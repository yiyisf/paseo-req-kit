import path from "node:path";
import { parseArgs } from "node:util";
import { type DefectHandling, PHASE_MODES, type PhaseMode, type ProfileName, type VerifyEnvironment } from "./config.js";
import { LAUNCHER } from "./locations.js";
import type { LaunchArgs } from "./preflight.js";

export { LAUNCHER };

export const USAGE = `用法：
  start-pipeline --feature <功能目录> [--profile quick|standard] [--resume | --restart]
  start-pipeline [--feature <功能目录>] --status   查看进度（不写 --feature 时：工作区里只有一个需求运行过就看它）
  start-pipeline --feature <功能目录> --stop       停止（之后可用 --resume 继续）
  start-pipeline --list                           列出这个项目所有工作区中的需求
  start-pipeline --feature <功能目录> --spec-review  确认前请另一个模型独立审阅需求说明草稿（后台进行，结果发回对话）
  start-pipeline --feature <功能目录> --worktree     为这个需求新建 Paseo worktree 工作区并在那里开发（对话目录不变）
  start-pipeline --feature <功能目录> --at 22:00     预约在指定时间开始（也可以写"明天 8:30""2026-10-14 08:30""+2h"）
  start-pipeline --feature <功能目录> --phases gated  分阶段：研发完成后停下等待测试验证（continuous | gated | develop-only）
  start-pipeline --feature <功能目录> --phase verify  开始测试验证阶段（研发阶段完成后；可以加 --at 预约）

  其他选项：[--repo <仓库目录>] [--origin-agent <agent ID>] [--config <配置文件>]

  --feature       功能目录，相对于仓库目录，例如 docs/features/20261012-sms-login；
                  也可以只写目录名（20261012-sms-login）或其中能唯一确定的一部分（sms-login）
  --repo          仓库目录。在 Paseo 的聊天中运行时默认为该聊天的工作目录，否则为当前目录
  --origin-agent  发起对话的 agent ID。在 Paseo 的聊天中运行时默认为该聊天（PASEO_AGENT_ID），
                  流水线会把进展和结果发回这个对话；在聊天之外运行且不传时，只写日志。
  --profile       档位：quick（快速，小改动）或 standard（标准）。不传时读取 spec 中的"档位"，
                  再不行用配置中的 defaultProfile
  --resume        从上次中断处继续
  --restart       丢弃上次的结果，完全从零开始（不参考上次的方案和代码）
  --phases        执行方式：continuous（连续，默认）、gated（分阶段）、develop-only（只做研发）。
                  不传时读取 spec 中的"执行方式"，再不行用配置中的 phases.mode
  --phase verify  开始测试验证阶段（等同于 --resume；研发完成、待测试验证时单独的 --resume 效果相同）
  --verify-at     分阶段时，研发完成后在这个时间自动开始测试验证（写法同 --at）
  --verify-env    测试验证的环境：local（本地启动服务）或 deployed（已部署的测试环境，需要 test-env.md）
  --defects       测试验证发现缺陷时：fix（当场修复并复验）、handback（退回研发阶段修复）、report（只记录）
  --config        配置文件，默认为 ~/.req-kit/config.json（可用环境变量 REQ_KIT_HOME 改变目录）`;

export function parseLaunchArgs(argv: string[]): LaunchArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      feature: { type: "string" },
      repo: { type: "string" },
      "origin-agent": { type: "string" },
      resume: { type: "boolean", default: false },
      restart: { type: "boolean", default: false },
      config: { type: "string" },
      profile: { type: "string" },
      status: { type: "boolean", default: false },
      stop: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      "spec-review": { type: "boolean", default: false },
      worktree: { type: "boolean", default: false },
      "source-repo": { type: "string" },
      "workspace-id": { type: "string" },
      at: { type: "string" },
      phases: { type: "string" },
      phase: { type: "string" },
      "verify-at": { type: "string" },
      "verify-env": { type: "string" },
      defects: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!values.feature && !values.list && !values.status) {
    throw new Error(`缺少 --feature\n\n${USAGE}`);
  }
  const profile = values.profile?.trim().toLowerCase();
  if (profile !== undefined && profile !== "quick" && profile !== "standard") {
    throw new Error(`--profile 只能是 quick 或 standard，收到 "${values.profile}"`);
  }
  if ([values.status, values.stop, values.resume, values.restart, values["spec-review"]].filter(Boolean).length > 1) {
    throw new Error("--status、--stop、--resume、--restart、--spec-review 一次只能用一个");
  }
  if (values.at && (values.status || values.stop || values["spec-review"] || values.resume)) {
    throw new Error("--at 只用于启动（预约开始时间）");
  }
  if (values.worktree && (values.status || values.stop || values["spec-review"] || values.resume)) {
    throw new Error("--worktree 只用于第一次启动（或 --restart）");
  }
  const phases = values.phases?.trim().toLowerCase();
  if (phases !== undefined && !PHASE_MODES.includes(phases as PhaseMode)) {
    throw new Error(`--phases 只能是 ${PHASE_MODES.join("、")}，收到 "${values.phases}"`);
  }
  const phase = values.phase?.trim().toLowerCase();
  if (phase !== undefined && phase !== "verify") throw new Error(`--phase 只能是 verify，收到 "${values.phase}"`);
  if (phase && (values.status || values.stop || values["spec-review"] || values.restart || values.worktree)) {
    throw new Error("--phase verify 只用于开始（或继续）测试验证阶段");
  }
  const verifyEnv = values["verify-env"]?.trim().toLowerCase();
  if (verifyEnv !== undefined && verifyEnv !== "local" && verifyEnv !== "deployed") {
    throw new Error(`--verify-env 只能是 local 或 deployed，收到 "${values["verify-env"]}"`);
  }
  const defects = values.defects?.trim().toLowerCase();
  if (defects !== undefined && !["fix", "handback", "report"].includes(defects)) {
    throw new Error(`--defects 只能是 fix、handback 或 report，收到 "${values.defects}"`);
  }
  // In a Paseo chat, the chat itself is the origin unless told otherwise.
  const origin = (values["origin-agent"] ?? process.env.PASEO_AGENT_ID)?.trim();
  return {
    // In a Paseo chat, the chat's working directory is the repository.
    repo: path.resolve(values.repo ?? process.env.PASEO_AGENT_CWD ?? process.cwd()),
    featureDir: values.feature ?? "",
    originAgentId: origin ? origin : null,
    resume: (values.resume ?? false) || phase === "verify",
    restart: values.restart ?? false,
    configPath: values.config ? path.resolve(values.config) : null,
    profile: (profile as ProfileName | undefined) ?? null,
    status: values.status ?? false,
    stop: values.stop ?? false,
    list: values.list ?? false,
    specReview: values["spec-review"] ?? false,
    worktree: values.worktree ?? false,
    sourceRepo: values["source-repo"] ? path.resolve(values["source-repo"]) : null,
    workspaceId: values["workspace-id"] ?? null,
    at: values.at ?? null,
    phases: (phases as PhaseMode | undefined) ?? null,
    phase: phase === "verify" ? "verify" : null,
    verifyAt: values["verify-at"] ?? null,
    verifyEnv: (verifyEnv as VerifyEnvironment | undefined) ?? null,
    defects: (defects as DefectHandling | undefined) ?? null,
  };
}

/** Double quotes work in bash, PowerShell and cmd alike; backslash paths are always quoted for bash. */
function quote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * The command a chat agent runs to continue this pipeline. The origin chat is not
 * named: run from a chat, that chat becomes the origin; run elsewhere, the previous
 * origin is kept.
 */
/** The command a chat agent runs to see progress (same shape as resumeCommand). */
export function statusCommand(args: { repo: string; featureDir: string; configPath: string | null }): string {
  return resumeCommand(args).replace(/ --resume$/, " --status");
}

/** The full start command, for a start scheduled for later (--at). */
export function startCommand(args: {
  repo: string;
  featureDir: string;
  configPath: string | null;
  profile: string | null;
  worktree: boolean;
  phases?: string | null;
  verifyAt?: string | null;
}): string {
  const parts = ["node", LAUNCHER, "--repo", args.repo, "--feature", args.featureDir];
  if (args.configPath) parts.push("--config", args.configPath);
  if (args.profile) parts.push("--profile", args.profile);
  if (args.worktree) parts.push("--worktree");
  if (args.phases) parts.push("--phases", args.phases);
  if (args.verifyAt) parts.push("--verify-at", args.verifyAt);
  return parts.map(quote).join(" ");
}

/** The command that starts the verify phase once development is done. */
export function verifyCommand(args: {
  repo: string;
  featureDir: string;
  configPath: string | null;
  verifyEnv?: string | null;
  defects?: string | null;
}): string {
  const extra = [args.verifyEnv ? ` --verify-env ${args.verifyEnv}` : "", args.defects ? ` --defects ${args.defects}` : ""].join("");
  return `${resumeCommand(args)} --phase verify${extra}`;
}

export function resumeCommand(args: { repo: string; featureDir: string; configPath: string | null }): string {
  const parts = ["node", LAUNCHER, "--repo", args.repo, "--feature", args.featureDir];
  if (args.configPath) parts.push("--config", args.configPath);
  parts.push("--resume");
  return parts.map(quote).join(" ");
}

/**
 * Arguments for the pipeline process, rebuilt from what the launcher resolved (short
 * feature names, a requirement's own worktree), so both processes see the same thing.
 */
export function launchArgv(args: LaunchArgs): string[] {
  const out = ["--repo", args.repo, "--feature", args.featureDir];
  if (args.originAgentId) out.push("--origin-agent", args.originAgentId);
  if (args.configPath) out.push("--config", args.configPath);
  if (args.profile) out.push("--profile", args.profile);
  if (args.resume) out.push("--resume");
  if (args.restart) out.push("--restart");
  if (args.sourceRepo) out.push("--source-repo", args.sourceRepo);
  if (args.workspaceId) out.push("--workspace-id", args.workspaceId);
  if (args.specReview) out.push("--spec-review");
  if (args.phases) out.push("--phases", args.phases);
  if (args.phase) out.push("--phase", args.phase);
  if (args.verifyAt) out.push("--verify-at", args.verifyAt);
  if (args.verifyEnv) out.push("--verify-env", args.verifyEnv);
  if (args.defects) out.push("--defects", args.defects);
  return out;
}
