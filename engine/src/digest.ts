// Requirement overview for a project, for people who are not in the chat:
//   req digest [--repo <dir>]                 print it
//   req digest --notify                       also send it to the configured notifiers (event "digest")
//   req digest --schedule "0 9 * * 1"         have Paseo run "req digest --notify" on a schedule (fresh agent)
//   req digest --cancel <schedule ID>         stop that schedule
// The schedule starts a short-lived agent (the builder, or digest.profile) only to run the command.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { type FeatureSummary, listFeatures } from "./features.js";
import { defaultConfigPath, KIT_ROOT, kitVersion } from "./locations.js";
import { dispatchNotifiers } from "./notifiers.js";
import { resolveConfigProfiles, usesPaseoProfiles } from "./paseo-profiles.js";
import { loadRuntimeFactory } from "./runtime-loader.js";

const GROUPS: Array<{ title: string; match: (stage: string) => boolean }> = [
  { title: "需要处理", match: (s) => s.startsWith("等待需求方决定") || s.startsWith("已中断") || s.startsWith("验收未通过") },
  { title: "待验收", match: (s) => s === "待验收" || s.startsWith("开发结束") },
  { title: "开发中", match: (s) => s === "开发中" },
  { title: "对齐中 / 未开始", match: (s) => s === "对齐中" || s.startsWith("已确认") },
  { title: "已验收", match: (s) => s === "已验收" },
];

export function digestText(project: string, features: FeatureSummary[], now = new Date(), days = 7): string {
  const since = now.getTime() - days * 24 * 3600_000;
  const recent = features.filter((f) => new Date(f.updatedAt).getTime() >= since);
  const lines = [`【req-kit 需求总览】${project}（${now.toLocaleDateString("zh-CN")}）`];
  if (features.length === 0) return `${lines[0]}\n还没有需求。`;
  const counts = GROUPS.map((g) => [g.title, features.filter((f) => g.match(f.stage)).length] as const).filter(([, n]) => n > 0);
  lines.push(`共 ${features.length} 个需求：${counts.map(([t, n]) => `${t} ${n}`).join("，")}；最近 ${days} 天有变化的 ${recent.length} 个。`);
  for (const group of GROUPS) {
    const items = features.filter((f) => group.match(f.stage) && (group.title !== "已验收" || recent.includes(f)));
    if (items.length === 0) continue;
    lines.push("", `${group.title}${group.title === "已验收" ? `（最近 ${days} 天）` : ""}：`);
    for (const f of items) {
      lines.push(`- ${f.title}（${f.name}）：${f.stage}${f.branch ? `，分支 ${f.branch}` : ""}${f.usage ? `；${f.usage}` : ""}`);
    }
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      repo: { type: "string" },
      config: { type: "string" },
      notify: { type: "boolean", default: false },
      schedule: { type: "string" },
      cancel: { type: "string" },
      days: { type: "string", default: "7" },
    },
  });
  const repo = fs.realpathSync(path.resolve(values.repo ?? process.env.PASEO_AGENT_CWD ?? process.cwd()));
  const configPath = values.config ? path.resolve(values.config) : defaultConfigPath();
  let config = loadConfig(configPath, repo).config;

  if (values.schedule || values.cancel) {
    const runtime = await (await loadRuntimeFactory())({ config, log: () => undefined });
    try {
      if (values.cancel) {
        await runtime.cancelSchedule(values.cancel);
        console.log(`已取消定时任务 ${values.cancel}。`);
        return 0;
      }
      if (usesPaseoProfiles(config)) config = resolveConfigProfiles(config, await runtime.listPaseoProfiles());
      const command = `node "${path.join(KIT_ROOT, "bin", "req.mjs").split(path.sep).join("/")}" digest --notify --repo "${repo}"${values.config ? ` --config "${configPath}"` : ""}`;
      const id = await runtime.scheduleNewAgent({
        name: `req-kit 需求总览：${path.basename(repo)}`,
        cron: values.schedule as string,
        cwd: repo,
        profile: config.agents.builder,
        prompt: `运行下面的命令，然后直接结束。不要做其他任何事，不要修改文件：\n\n${command}`,
      });
      if (!id) {
        console.error("这个 Paseo 版本不支持定时任务。");
        return 1;
      }
      console.log(`已创建定时任务 ${id}：按"${values.schedule}"（本机时区）把需求总览发到配置的外部通知。取消：req digest --cancel ${id}`);
      return 0;
    } finally {
      await runtime.close().catch(() => undefined);
    }
  }

  const features = listFeatures(repo);
  const text = digestText(path.basename(repo), features, new Date(), Number(values.days) || 7);
  console.log(text);
  if (!values.notify) return 0;
  if (config.notifiers.length === 0) {
    console.error("\n没有配置外部通知（notifiers），只打印了总览。");
    return 1;
  }
  let failed = false;
  await dispatchNotifiers(
    config.notifiers,
    {
      schema: 1,
      type: "digest",
      at: new Date().toISOString(),
      kitVersion: kitVersion(),
      feature: { dir: "docs/features", name: "", title: `${path.basename(repo)} 需求总览` },
      repo,
      branch: null,
      profile: "",
      originAgentId: null,
      text,
      details: {
        features: features.map((f) => ({ name: f.name, title: f.title, stage: f.stage, branch: f.branch, updatedAt: f.updatedAt, usage: f.usage })),
      },
    },
    (message) => {
      if (message.startsWith("外部通知失败")) failed = true;
      console.error(message);
    },
  );
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
