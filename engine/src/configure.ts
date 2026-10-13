// Configuration wizard: `node install.mjs --configure` (or `req configure`).
// Lists what the local Paseo daemon offers and writes ~/.req-kit/config.json from
// a few multiple-choice questions, so nobody has to hand-edit JSON or guess mode names.

import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { AgentProfile } from "./config.js";
import { connect } from "./daemon-check.js";
import { defaultConfigPath, KIT_ROOT } from "./locations.js";

export interface CatalogEntry {
  id: string;
  label?: string;
}

/** What the daemon offers; the real one wraps the Paseo SDK, tests use a fixed one. */
export interface Catalog {
  providers(): Promise<Array<CatalogEntry & { status: string }>>;
  models(provider: string): Promise<CatalogEntry[]>;
  modes(provider: string): Promise<CatalogEntry[]>;
}

export interface Choice<T> {
  label: string;
  value: T;
}

/** Asks one multiple-choice question; options[0] is the recommendation. */
export type Chooser = <T>(question: string, options: Choice<T>[]) => Promise<T>;

const ROLE_TEXT = {
  builder: "builder（方案设计、写代码、修复、写报告）",
  reviewer: "reviewer（方案审核、代码评审、功能验证）",
} as const;

/** Mode that never stops for approval, per provider; null when the provider has no modes. */
export function unattendedMode(provider: string, modes: CatalogEntry[]): string | null {
  if (modes.length === 0) return null;
  const preferred: Record<string, string[]> = {
    claude: ["bypassPermissions"],
    codex: ["full-access"],
    opencode: ["build"],
  };
  const ids = modes.map((m) => m.id);
  for (const id of preferred[provider] ?? ["full-access", "bypassPermissions", "build"]) {
    if (ids.includes(id)) return id;
  }
  return null;
}

/** Builds one role's agent settings from the chosen provider, model and mode. */
export function profileFor(provider: string, model: string, modeId: string | null): AgentProfile {
  const profile: AgentProfile = { provider: `${provider}/${model}` };
  if (modeId) profile.modeId = modeId;
  if (provider === "opencode") profile.featureValues = { auto_accept: true };
  return profile;
}

async function chooseRole(
  role: "builder" | "reviewer",
  catalog: Catalog,
  choose: Chooser,
  avoidProvider: string | null,
): Promise<AgentProfile> {
  const providers = (await catalog.providers()).filter((p) => p.status === "ready");
  if (providers.length === 0) throw new Error("daemon 上没有可用的 agent。请先在 Paseo 中安装并登录至少一种 agent。");
  // Recommend a different provider for the reviewer: a second model catches different problems.
  const ordered = avoidProvider ? [...providers.filter((p) => p.id !== avoidProvider), ...providers.filter((p) => p.id === avoidProvider)] : providers;
  const provider = await choose(
    `${ROLE_TEXT[role]}用哪个 agent？${avoidProvider ? "（建议与 builder 不同，评审更容易发现问题）" : ""}`,
    ordered.map((p) => ({ label: p.label ? `${p.label}（${p.id}）` : p.id, value: p.id })),
  );
  const models = await catalog.models(provider);
  if (models.length === 0) throw new Error(`${provider} 没有列出可用的模型。请在 Paseo 中检查它的登录状态。`);
  const model = await choose(
    `${ROLE_TEXT[role]}用哪个模型？`,
    models.map((m) => ({ label: m.label && m.label !== m.id ? `${m.label}（${m.id}）` : m.id, value: m.id })),
  );
  const modes = await catalog.modes(provider);
  let modeId = unattendedMode(provider, modes);
  if (modes.length > 0 && !modeId) {
    modeId = await choose(
      `没有找到 ${provider} 的免确认模式，请选择一个不会停下来等待批准的模式：`,
      modes.map((m) => ({ label: m.label ? `${m.label}（${m.id}）` : m.id, value: m.id })),
    );
  }
  return profileFor(provider, model, modeId);
}

export interface WizardResult {
  config: Record<string, unknown>;
  summary: string[];
}

/** Asks the questions and returns the new config (existing settings are kept). */
export async function runWizard(existing: Record<string, unknown>, catalog: Catalog, choose: Chooser): Promise<WizardResult> {
  const builder = await chooseRole("builder", catalog, choose, null);
  const reviewer = await chooseRole("reviewer", catalog, choose, builder.provider.split("/")[0]);
  const defaultProfile = await choose("没有特别说明时，需求默认走哪个档位？", [
    { label: "标准：完整的方案审核、代码评审和验证（推荐）", value: "standard" },
    { label: "快速：每个环节一轮，适合以小改动为主的项目", value: "quick" },
  ]);
  const notifyMilestones = await choose("开发过程中要不要在对话里发几句进展（方案定了、开始验证等）？", [
    { label: "要（推荐）", value: true },
    { label: "不要，只发需要处理的事和最终结果", value: false },
  ]);
  const config = { ...existing, agents: { builder, reviewer }, defaultProfile, notifyMilestones };
  const describe = (p: AgentProfile) => `${p.provider}${p.modeId ? `（模式 ${p.modeId}）` : ""}${p.featureValues ? "，自动接受权限请求" : ""}`;
  return {
    config,
    summary: [`builder：${describe(builder)}`, `reviewer：${describe(reviewer)}`, `默认档位：${defaultProfile}`, `进展通知：${notifyMilestones ? "开" : "关"}`],
  };
}

function terminalChooser(): { choose: Chooser; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const choose: Chooser = async (question, options) => {
    console.log(`\n${question}`);
    options.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}${i === 0 ? "  ← 推荐" : ""}`));
    for (;;) {
      const answer = (await rl.question(`请输入编号（直接回车选 1）：`)).trim();
      if (answer === "") return options[0].value;
      const n = Number(answer);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
      console.log(`请输入 1 到 ${options.length} 之间的编号。`);
    }
  };
  return { choose, close: () => rl.close() };
}

async function main(): Promise<number> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { config: { type: "string" } } });
  const configPath = values.config ? path.resolve(values.config) : defaultConfigPath();
  const existing = fs.existsSync(configPath)
    ? (JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>)
    : (JSON.parse(fs.readFileSync(path.join(KIT_ROOT, "config.example.json"), "utf8")) as Record<string, unknown>);
  const settings = {
    daemonUrl: typeof existing.daemonUrl === "string" ? existing.daemonUrl : "ws://127.0.0.1:6767/ws",
    daemonPasswordEnv: typeof existing.daemonPasswordEnv === "string" ? existing.daemonPasswordEnv : "PASEO_DAEMON_PASSWORD",
  };
  console.log(`配置向导：连接 Paseo daemon ${settings.daemonUrl} ……`);
  let client;
  try {
    client = await connect(settings as never);
  } catch (error) {
    console.error(`无法连接 daemon：${(error as Error).message}`);
    console.error(`请确认 Paseo 正在运行；设置了密码时，确认环境变量 ${settings.daemonPasswordEnv} 已设置。`);
    return 1;
  }
  const catalog: Catalog = {
    async providers() {
      const snapshot = await client.providers.waitForReady({ timeoutMs: 60_000 });
      return snapshot.entries.map((e) => ({ id: e.provider, status: e.status }));
    },
    async models(provider) {
      return ((await client.providers.listModels(provider)).models ?? []).map((m) => ({ id: m.id, label: m.label }));
    },
    async modes(provider) {
      return ((await client.providers.listModes(provider)).modes ?? []).map((m) => ({ id: m.id, label: m.label }));
    },
  };
  const terminal = terminalChooser();
  try {
    const { config, summary } = await runWizard(existing, catalog, terminal.choose);
    console.log("\n将写入以下设置：");
    for (const line of summary) console.log(`  ${line}`);
    const ok = await terminal.choose("确认写入吗？", [
      { label: "写入", value: true },
      { label: "放弃", value: false },
    ]);
    if (!ok) {
      console.log("没有修改配置。");
      return 1;
    }
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    if (fs.existsSync(configPath)) fs.copyFileSync(configPath, `${configPath}.bak-${Date.now()}`);
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`\n已写入 ${configPath}（原文件已备份）。接下来运行 npm run smoke -- check 确认两个 agent 能正常工作。`);
    return 0;
  } finally {
    terminal.close();
    await client.close().catch(() => undefined);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().then(
    (code) => process.exit(code),
    (error: Error) => {
      console.error(`配置向导出错：${error.message}`);
      process.exit(1);
    },
  );
}
