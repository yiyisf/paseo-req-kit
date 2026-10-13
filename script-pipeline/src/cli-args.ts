import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ProfileName } from "./config.js";
import type { LaunchArgs } from "./preflight.js";

export const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LAUNCHER = path.join(TOOL_DIR, "bin", "start-pipeline.mjs");

export const USAGE = `用法：
  start-pipeline --feature <功能目录> [--profile quick|standard] [--resume | --restart]
  start-pipeline --feature <功能目录> --status     查看进度
  start-pipeline --feature <功能目录> --stop       停止（之后可用 --resume 继续）

  其他选项：[--repo <仓库目录>] [--origin-agent <agent ID>] [--config <配置文件>]

  --feature       功能目录，相对于仓库目录，例如 docs/features/20261012-sms-login
  --repo          仓库目录。在 Paseo 的聊天中运行时默认为该聊天的工作目录，否则为当前目录
  --origin-agent  发起对话的 agent ID。在 Paseo 的聊天中运行时默认为该聊天（PASEO_AGENT_ID），
                  流水线会把进展和结果发回这个对话；在聊天之外运行且不传时，只写日志。
  --profile       档位：quick（快速，小改动）或 standard（标准）。不传时读取 spec 中的"档位"，
                  再不行用配置中的 defaultProfile
  --resume        从上次中断处继续
  --restart       丢弃上次的结果，从方案设计重新开始
  --config        配置文件，默认为工具目录下的 pipeline.config.json`;

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
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!values.feature) {
    throw new Error(`缺少 --feature\n\n${USAGE}`);
  }
  const profile = values.profile?.trim().toLowerCase();
  if (profile !== undefined && profile !== "quick" && profile !== "standard") {
    throw new Error(`--profile 只能是 quick 或 standard，收到 "${values.profile}"`);
  }
  if ([values.status, values.stop, values.resume, values.restart].filter(Boolean).length > 1) {
    throw new Error("--status、--stop、--resume、--restart 一次只能用一个");
  }
  // In a Paseo chat, the chat itself is the origin unless told otherwise.
  const origin = (values["origin-agent"] ?? process.env.PASEO_AGENT_ID)?.trim();
  return {
    // In a Paseo chat, the chat's working directory is the repository.
    repo: path.resolve(values.repo ?? process.env.PASEO_AGENT_CWD ?? process.cwd()),
    featureDir: values.feature,
    originAgentId: origin ? origin : null,
    resume: values.resume ?? false,
    restart: values.restart ?? false,
    configPath: values.config ? path.resolve(values.config) : null,
    profile: (profile as ProfileName | undefined) ?? null,
    status: values.status ?? false,
    stop: values.stop ?? false,
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
export function resumeCommand(args: { repo: string; featureDir: string; configPath: string | null }): string {
  const parts = ["node", LAUNCHER, "--repo", args.repo, "--feature", args.featureDir];
  if (args.configPath) parts.push("--config", args.configPath);
  parts.push("--resume");
  return parts.map(quote).join(" ");
}
