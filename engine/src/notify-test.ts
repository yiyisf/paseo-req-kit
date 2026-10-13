// Sends one test event to every configured notifier: `req notify-test [--type blocked] [--repo <dir>]`.
// Lets whoever implements the IM module check it without running a pipeline.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { defaultConfigPath, kitVersion } from "./locations.js";
import { dispatchNotifiers, NOTIFIER_EVENT_TYPES, type NotifierEvent, type NotifierEventType } from "./notifiers.js";

/** A realistic event of the given type, with the details the pipeline would send. */
export function sampleEvent(type: NotifierEventType, repo: string): NotifierEvent {
  const featureDir = "docs/features/20261012-sms-login";
  const resume = `node "<req-kit>/bin/start-pipeline.mjs" --feature ${featureDir} --resume`;
  const samples: Record<NotifierEventType, { text: string; details: Record<string, unknown> }> = {
    milestone: { text: "技术方案已经确定（审核 1 轮），开始写代码。", details: { milestone: "design-settled" } },
    blocked: {
      text: "方案审核发现 1 个需要需求方决定的问题，流水线已暂停，请到发起的对话中回答。",
      details: { questions: ["验证码有效期是 5 分钟还是 10 分钟？"], resumeCommand: resume },
    },
    permission: {
      text: "「实现」步骤在等待权限批准，批准前会一直停在这里。",
      details: { stepTitle: "实现", agentTitle: "实现 · 短信验证码登录", requests: ["运行 npm install"] },
    },
    failed: {
      text: "开发流水线在「代码评审」步骤中断：agent 连续出错。",
      details: { stepTitle: "代码评审", reason: "agent 连续出错", logPath: `${featureDir}/.pipeline/pipeline.log`, resumeCommand: resume },
    },
    digest: {
      text: "【req-kit 需求总览】shop\n共 3 个需求：需要处理 1，待验收 1，开发中 1。",
      details: { features: [{ name: "20261012-sms-login", title: "短信验证码登录", stage: "待验收" }] },
    },
    phase_done: {
      text: `研发已完成，可以提测：提测说明在 ${featureDir}/handoff.md。`,
      details: { handoffPath: `${featureDir}/handoff.md`, mode: "gated", verifyCommand: `${resume} --phase verify`, verifyAt: null, handbacks: 0 },
    },
    completed: {
      text: "开发流水线已结束：已完成，可以验收。",
      details: { outcome: "completed", summary: "6 条验收标准全部通过。", reportPath: `${featureDir}/report.md` },
    },
  };
  return {
    schema: 1,
    type,
    at: new Date().toISOString(),
    kitVersion: kitVersion(),
    feature: { dir: featureDir, name: "20261012-sms-login", title: "短信验证码登录（测试消息）" },
    repo,
    branch: "feature/20261012-sms-login",
    profile: "standard",
    originAgentId: null,
    text: `【测试】${samples[type].text}`,
    details: samples[type].details,
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { type: { type: "string", default: "completed" }, repo: { type: "string" }, config: { type: "string" } },
  });
  const type = values.type as NotifierEventType;
  if (!NOTIFIER_EVENT_TYPES.includes(type)) {
    console.error(`--type 只能是 ${NOTIFIER_EVENT_TYPES.join("、")} 之一`);
    return 2;
  }
  const repo = path.resolve(values.repo ?? process.cwd());
  const configPath = values.config ? path.resolve(values.config) : defaultConfigPath();
  const { config } = loadConfig(configPath, fs.existsSync(repo) ? repo : undefined);
  if (config.notifiers.length === 0) {
    console.log(`没有配置外部通知（${configPath} 中的 notifiers 为空）。写法见 notifiers/im-template.mjs 开头的说明。`);
    return 1;
  }
  const wanted = config.notifiers.filter((n) => !n.events || n.events.includes(type));
  if (wanted.length === 0) {
    console.log(`配置的通知都没有订阅 ${type} 事件。可以用 --type 换一种，例如 --type ${config.notifiers[0].events?.[0] ?? "completed"}。`);
    return 1;
  }
  let failed = false;
  // Lets a module show what it would send (the template does) without a real IM.
  process.env.REQ_KIT_NOTIFY_TEST = "1";
  await dispatchNotifiers(config.notifiers, sampleEvent(type, repo), (message) => {
    if (message.startsWith("外部通知失败")) failed = true;
    console.log(message);
  });
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().then(
    (code) => process.exit(code),
    (error: Error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
