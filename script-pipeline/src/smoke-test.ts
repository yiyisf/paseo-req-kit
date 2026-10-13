// Checks the parts of the pipeline that depend on your real Paseo setup.
//
//   npm run smoke -- check                        daemon, providers, models, modes; one tiny agent per role
//   npm run smoke -- notify --origin-agent <id>   message + subagent into an existing chat
//   npm run smoke -- detach-start                 start a background heartbeat (run from a Paseo chat)
//   npm run smoke -- detach-check                 is that heartbeat still alive?
//
// See README.md, "冒烟测试", for when to run each one.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { TOOL_DIR } from "./cli-args.js";
import { type AgentProfile, defaultConfigPath, loadConfig, type PipelineConfig } from "./config.js";

const HEARTBEAT = path.join(os.tmpdir(), "requirement-pipeline-heartbeat.json");

function line(ok: boolean, text: string): void {
  console.log(`${ok ? "✓" : "✗"} ${text}`);
}

async function connect(config: PipelineConfig) {
  const { createPaseoClient } = await import("@getpaseo/client");
  const password = process.env[config.daemonPasswordEnv];
  const client = createPaseoClient({ url: config.daemonUrl, ...(password ? { password } : {}) });
  await client.connect();
  return client;
}

type Client = Awaited<ReturnType<typeof connect>>;

async function checkProfile(client: Client, role: string, profile: AgentProfile): Promise<boolean> {
  const [provider, model] = [profile.provider.slice(0, profile.provider.indexOf("/")), profile.provider.slice(profile.provider.indexOf("/") + 1)];
  let ok = true;
  try {
    const models = await client.providers.listModels(provider);
    const ids = (models.models ?? []).map((m) => m.id);
    const found = ids.includes(model);
    ok &&= found;
    line(found, `${role}：模型 ${profile.provider}${found ? "" : ` 不存在。可用：${ids.join(", ") || "（无）"}`}`);
  } catch (error) {
    line(false, `${role}：无法列出 ${provider} 的模型：${(error as Error).message}`);
    return false;
  }
  // Some providers (e.g. Pi) have no modes and never stop for approvals; they need no modeId.
  try {
    const modes = await client.providers.listModes(provider);
    const ids = (modes.modes ?? []).map((m) => m.id);
    if (ids.length === 0) {
      const fine = !profile.modeId;
      ok &&= fine;
      line(fine, fine ? `${role}：${provider} 没有模式，不需要 modeId` : `${role}：${provider} 没有模式，请删除 modeId（当前为 ${profile.modeId}）`);
    } else if (!profile.modeId) {
      line(false, `${role}：没有设置 modeId，agent 可能会停下来等待权限批准。可用：${ids.join(", ")}`);
      ok = false;
    } else if (provider === "opencode" && profile.featureValues?.auto_accept !== true) {
      line(false, `${role}：OpenCode 需要设置 "featureValues": { "auto_accept": true }，否则会停下来等待权限批准`);
      ok = false;
    } else {
      const found = ids.includes(profile.modeId);
      ok &&= found;
      line(found, `${role}：模式 ${profile.modeId}${found ? "" : ` 不存在。可用：${ids.join(", ")}`}`);
    }
  } catch (error) {
    line(false, `${role}：无法列出 ${provider} 的模式：${(error as Error).message}`);
    ok = false;
  }
  return ok;
}

async function tinyAgent(client: Client, role: string, profile: AgentProfile): Promise<boolean> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `requirement-pipeline-smoke-${role}-`));
  const agent = await client.agents.create({
    config: {
      provider: profile.provider,
      ...(profile.modeId ? { modeId: profile.modeId } : {}),
      ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
      ...(profile.featureValues ? { featureValues: profile.featureValues } : {}),
    },
    cwd: dir,
    title: `[冒烟测试] ${role}`,
    labels: { "requirement-pipeline": "smoke-test" },
    prompt: `在当前目录创建文件 smoke.txt，内容只有一行：ok-${role}。然后用 node 执行 \`node -e "require('fs').writeFileSync('shell.txt','ran')"\`。完成后直接结束，不要做其他事。`,
  });
  console.log(`  已创建 agent ${agent.id}，等待它完成（最多 5 分钟）……`);
  try {
    const result = await agent.waitForFinish(5 * 60_000);
    if (result.status === "permission") {
      line(false, `${role}：agent 停下来等待权限批准。请把 agents.${role}.modeId 改成免确认的模式。`);
      return false;
    }
    if (result.status !== "idle") {
      line(false, `${role}：agent 结束状态为 ${result.status}：${result.error ?? ""}`);
      return false;
    }
    const wrote = fs.existsSync(path.join(dir, "smoke.txt"));
    const ran = fs.existsSync(path.join(dir, "shell.txt"));
    line(wrote && ran, `${role}：agent 能写文件${wrote ? "" : "（失败）"}、能执行命令${ran ? "" : "（失败）"}`);
    return wrote && ran;
  } finally {
    await agent.archive().catch(() => undefined);
  }
}

async function check(config: PipelineConfig): Promise<number> {
  let client: Client;
  try {
    client = await connect(config);
    line(true, `已连接 daemon：${config.daemonUrl}`);
  } catch (error) {
    line(false, `无法连接 daemon ${config.daemonUrl}：${(error as Error).message}`);
    return 1;
  }
  try {
    const snapshot = await client.providers.waitForReady({ timeoutMs: 60_000 });
    console.log("  daemon 上可用的 provider：");
    for (const entry of snapshot.entries) {
      console.log(`    - ${entry.provider}（${entry.status}）`);
    }
    let ok = true;
    for (const role of ["builder", "reviewer"] as const) {
      ok = (await checkProfile(client, role, config.agents[role])) && ok;
    }
    if (!ok) {
      console.log("\n请先修正 pipeline.config.json 中的 provider/model 和 modeId，再重新运行。");
      return 1;
    }
    for (const role of ["builder", "reviewer"] as const) {
      ok = (await tinyAgent(client, role, config.agents[role])) && ok;
    }
    console.log(ok ? "\n全部通过。" : "\n有检查没有通过，见上面的 ✗。");
    return ok ? 0 : 1;
  } finally {
    await client.close();
  }
}

async function notify(config: PipelineConfig, origin: string): Promise<number> {
  const client = await connect(config);
  try {
    await client.agents.ref(origin).send(
      "【需求开发流水线通知】这是一条冒烟测试消息，不是用户发的。请回复用户：\"流水线的通知通道工作正常。\"",
      { activeTurnBehavior: "steer" },
    );
    line(true, `已向 agent ${origin} 发送测试通知。请到该对话中确认 agent 转告了"通知通道工作正常"。`);

    const child = await client.agents.create({
      config: {
        provider: config.agents.builder.provider,
        ...(config.agents.builder.modeId ? { modeId: config.agents.builder.modeId } : {}),
      },
      cwd: process.cwd(),
      parent: origin,
      title: "[冒烟测试] 子 agent",
      labels: { "requirement-pipeline": "smoke-test" },
      prompt: "只回复\"ok\"，然后结束。不要读写任何文件。",
    });
    const result = await child.waitForFinish(3 * 60_000);
    line(result.status === "idle", `已在该对话下创建子 agent ${child.id}（结束状态 ${result.status}）。请确认它出现在对话的子 agent 列表中。`);
    await child.archive().catch(() => undefined);
    return result.status === "idle" ? 0 : 1;
  } catch (error) {
    line(false, (error as Error).message);
    return 1;
  } finally {
    await client.close();
  }
}

function detachStart(): number {
  const script = `
    const fs = require("fs");
    const end = Date.now() + 10 * 60_000;
    const beat = () => fs.writeFileSync(${JSON.stringify(HEARTBEAT)}, JSON.stringify({ pid: process.pid, at: Date.now(), startedAt }));
    const startedAt = Date.now();
    beat();
    const timer = setInterval(() => { if (Date.now() > end) { clearInterval(timer); return; } beat(); }, 2000);
  `;
  // Same detach mechanism as launch.ts.
  const child = spawn(process.execPath, ["-e", script], { detached: true, windowsHide: true, stdio: "ignore" });
  child.unref();
  console.log(`已启动后台心跳进程 ${child.pid}（持续 10 分钟），心跳文件：${HEARTBEAT}`);
  console.log("请结束这一轮对话，等待至少 1 分钟后，再让 agent 运行 detach-check。");
  return 0;
}

function detachCheck(): number {
  if (!fs.existsSync(HEARTBEAT)) {
    line(false, "找不到心跳文件，请先运行 detach-start");
    return 1;
  }
  const beat = JSON.parse(fs.readFileSync(HEARTBEAT, "utf8")) as { pid: number; at: number; startedAt: number };
  const age = Math.round((Date.now() - beat.at) / 1000);
  const ranFor = Math.round((beat.at - beat.startedAt) / 1000);
  const alive = age < 10;
  line(
    alive,
    alive
      ? `后台进程 ${beat.pid} 仍在运行（已运行 ${ranFor} 秒）。聊天 agent 启动的后台流水线可以在它的回合结束后继续运行。`
      : `后台进程 ${beat.pid} 在启动后约 ${ranFor} 秒停止（最后一次心跳在 ${age} 秒前）。` +
          "聊天 agent 的回合结束时，它启动的后台进程被终止了；需要改用插件方式启动流水线。",
  );
  return alive ? 0 : 1;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { "origin-agent": { type: "string" }, config: { type: "string" } },
    allowPositionals: true,
  });
  const command = positionals[0];
  if (command === "detach-start") return detachStart();
  if (command === "detach-check") return detachCheck();

  const config = loadConfig(values.config ? path.resolve(values.config) : defaultConfigPath(TOOL_DIR)).config;
  if (command === "check") return check(config);
  if (command === "notify") {
    const origin = values["origin-agent"] ?? process.env.PASEO_AGENT_ID;
    if (!origin) {
      console.error("需要 --origin-agent <agent ID>，或在 Paseo 的聊天中运行（自动读取 PASEO_AGENT_ID）");
      return 2;
    }
    return notify(config, origin);
  }
  console.error("用法：npm run smoke -- check | notify --origin-agent <id> | detach-start | detach-check");
  return 2;
}

main().then(
  (code) => process.exit(code),
  (error: Error) => {
    console.error(error.message);
    process.exit(1);
  },
);
