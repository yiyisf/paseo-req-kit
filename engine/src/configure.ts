// Configuration wizard: `node install.mjs --configure` (or `req configure`).
// Lists what the local Paseo daemon offers and writes ~/.req-kit/config.json from
// a few multiple-choice questions, so nobody has to hand-edit JSON or guess mode names.

import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { AgentProfile } from "./config.js";
import { connect } from "./daemon-check.js";
import { type PaseoProfile, profilesFromDaemonConfig } from "./paseo-profiles.js";
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
  /** Agent profiles set up in Paseo; optional. */
  profiles?(): Promise<PaseoProfile[]>;
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

const ROLE_HINTS = {
  builder: /实现|开发|编码|写代码|implement|build|cod/i,
  reviewer: /评审|审核|审查|检查|review|audit/i,
} as const;

/** Offers the Paseo profiles first, when there are any; null means "choose the agent directly". */
async function chooseProfile(
  role: "builder" | "reviewer",
  profiles: PaseoProfile[],
  choose: Chooser,
  avoidProvider: string | null,
): Promise<PaseoProfile | null> {
  const usable = profiles.filter((p) => p.model);
  if (usable.length === 0) return null;
  const score = (p: PaseoProfile) =>
    (ROLE_HINTS[role].test(`${p.name} ${p.notes ?? ""}`) ? 2 : 0) + (avoidProvider && p.provider !== avoidProvider ? 1 : 0);
  const ordered = [...usable].sort((a, b) => score(b) - score(a));
  const picked = await choose<PaseoProfile | null>(`${ROLE_TEXT[role]}用 Paseo 中的哪个 agent profile？`, [
    ...ordered.map((p) => ({
      label: `「${p.name}」：${p.provider}/${p.model}${p.modeId ? `，模式 ${p.modeId}` : ""}${p.notes ? `（${p.notes.slice(0, 40)}）` : ""}`,
      value: p as PaseoProfile | null,
    })),
    { label: "不用 profile，直接选择 agent 和模型", value: null },
  ]);
  return picked;
}

async function chooseRole(
  role: "builder" | "reviewer",
  catalog: Catalog,
  choose: Chooser,
  avoidProvider: string | null,
  profiles: PaseoProfile[] = [],
): Promise<AgentProfile> {
  const fromPaseo = await chooseProfile(role, profiles, choose, avoidProvider);
  if (fromPaseo) return { paseoProfile: fromPaseo.name };
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

/** One agent a role can use: a Paseo profile, or a provider's model in its unattended mode (1.12). */
export interface AgentChoice {
  id: string;
  label: string;
  provider: string;
  profile: AgentProfile;
}

/** Everything the daemon offers that can run unattended; Paseo profiles first. */
export async function agentChoices(catalog: Catalog): Promise<AgentChoice[]> {
  const out: AgentChoice[] = [];
  for (const p of ((await catalog.profiles?.().catch(() => [])) ?? []).filter((x) => x.model)) {
    out.push({ id: `paseo:${p.name}`, label: `Paseo profile「${p.name}」：${p.provider}/${p.model}`, provider: p.provider ?? "", profile: { paseoProfile: p.name } });
  }
  for (const provider of (await catalog.providers()).filter((p) => p.status === "ready")) {
    const modes = await catalog.modes(provider.id).catch(() => []);
    const modeId = unattendedMode(provider.id, modes);
    // A provider whose modes all stop for approval would hold the pipeline: left out.
    if (modes.length > 0 && !modeId) continue;
    for (const m of await catalog.models(provider.id).catch(() => [])) {
      out.push({
        id: `${provider.id}/${m.id}`,
        label: `${m.label && m.label !== m.id ? `${m.label}（${provider.id}/${m.id}）` : `${provider.id}/${m.id}`}${modeId ? `，模式 ${modeId}` : ""}`,
        provider: provider.id,
        profile: profileFor(provider.id, m.id, modeId),
      });
    }
  }
  return out;
}

/** The recommended fallback: another vendor than both roles if there is one, else the reviewer's when it differs from the builder's. */
export function recommendFallback(choices: AgentChoice[], builderProvider: string, reviewerProvider: string): AgentChoice | null {
  return (
    choices.find((c) => c.provider !== builderProvider && c.provider !== reviewerProvider) ??
    (reviewerProvider !== builderProvider ? (choices.find((c) => c.provider === reviewerProvider) ?? null) : null)
  );
}

/** Takes the recommended answer to every question (install, `req configure --auto`). */
export const recommended: Chooser = async (_question, options) => options[0].value;

export interface WizardResult {
  config: Record<string, unknown>;
  summary: string[];
}

/** Asks the questions and returns the new config (existing settings are kept). */
export async function runWizard(existing: Record<string, unknown>, catalog: Catalog, choose: Chooser): Promise<WizardResult> {
  const profiles = (await catalog.profiles?.().catch(() => [])) ?? [];
  const providerOf = (p: AgentProfile) => (p.provider ?? profiles.find((x) => x.name === p.paseoProfile)?.provider ?? "").split("/")[0];
  const builder = await chooseRole("builder", catalog, choose, null, profiles);
  const reviewer = await chooseRole("reviewer", catalog, choose, providerOf(builder), profiles);
  const choices = await agentChoices(catalog);
  const suggested = recommendFallback(choices, providerOf(builder), providerOf(reviewer));
  const others = choices.filter((c) => c.id !== suggested?.id && c.provider !== providerOf(builder)).slice(0, 8);
  const fallback = await choose<AgentProfile | null>(
    "备用模型：builder 或 reviewer 一直限流、额度用完或报错时，换它把这一步做完，而不是停下等人。用哪个？",
    [
      ...(suggested ? [{ label: `${suggested.label}（推荐：与主模型不同厂商）`, value: suggested.profile as AgentProfile | null }] : []),
      { label: "不用备用模型", value: null },
      ...others.map((c) => ({ label: c.label, value: c.profile as AgentProfile | null })),
    ],
  );
  const defaultProfile = await choose("没有特别说明时，需求默认走哪个档位？", [
    { label: "标准：完整的方案审核、代码评审和验证（推荐）", value: "standard" },
    { label: "快速：每个环节一轮，适合以小改动为主的项目", value: "quick" },
  ]);
  const notifyMilestones = await choose("开发过程中要不要在对话里发几句进展（方案定了、开始验证等）？", [
    { label: "要（推荐）", value: true },
    { label: "不要，只发需要处理的事和最终结果", value: false },
  ]);
  const config = { ...existing, agents: { builder, reviewer, ...(fallback ? { fallback } : {}) }, defaultProfile, notifyMilestones };
  const describe = (p: AgentProfile) =>
    p.paseoProfile
      ? `Paseo profile「${p.paseoProfile}」（在 Paseo 中修改这个 profile 即可换模型）`
      : `${p.provider}${p.modeId ? `（模式 ${p.modeId}）` : ""}${p.featureValues ? "，自动接受权限请求" : ""}`;
  return {
    config,
    summary: [
      `builder：${describe(builder)}`,
      `reviewer：${describe(reviewer)}${providerOf(reviewer) === providerOf(builder) ? "（只有一种 agent 可用，评审用同一个；以后登录第二种 agent 再运行 req configure，评审更容易发现问题）" : ""}`,
      `备用模型：${fallback ? describe(fallback) : "不用"}`,
      `默认档位：${defaultProfile}`, `进展通知：${notifyMilestones ? "开" : "关"}`],
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

function readConfigFile(configPath: string): Record<string, unknown> {
  return fs.existsSync(configPath)
    ? (JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>)
    : (JSON.parse(fs.readFileSync(path.join(KIT_ROOT, "config.example.json"), "utf8")) as Record<string, unknown>);
}

function writeConfigFile(configPath: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (fs.existsSync(configPath)) fs.copyFileSync(configPath, `${configPath}.bak-${Date.now()}`);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

/** The agents the plugin's settings page chose (1.12): checked, then written to the local config. */
export function applyAgents(existing: Record<string, unknown>, raw: unknown): Record<string, unknown> {
  const input = (raw ?? {}) as { builder?: unknown; reviewer?: unknown; fallback?: unknown };
  const isProfile = (p: unknown): p is AgentProfile => {
    if (!p || typeof p !== "object") return false;
    const q = p as AgentProfile;
    return (typeof q.paseoProfile === "string" && q.paseoProfile.trim() !== "") || (typeof q.provider === "string" && /^[^/]+\/.+/.test(q.provider) && !q.provider.includes("CHANGE-ME"));
  };
  if (!isProfile(input.builder) || !isProfile(input.reviewer)) throw new Error("builder 和 reviewer 都要选一个 agent");
  if (input.fallback !== null && input.fallback !== undefined && !isProfile(input.fallback)) throw new Error("备用模型的设置不对");
  const agents: Record<string, AgentProfile> = { builder: input.builder, reviewer: input.reviewer };
  if (input.fallback) agents.fallback = input.fallback as AgentProfile;
  return { ...existing, agents };
}

function daemonCatalog(client: Awaited<ReturnType<typeof connect>>): Catalog {
  return {
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
    async profiles() {
      return profilesFromDaemonConfig((await client.config.get()).config) ?? [];
    },
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { config: { type: "string" }, auto: { type: "boolean", default: false }, "catalog-json": { type: "boolean", default: false }, set: { type: "string" } },
  });
  const configPath = values.config ? path.resolve(values.config) : defaultConfigPath();
  const existing = readConfigFile(configPath);
  const json = (data: unknown) => console.log(JSON.stringify(data));

  if (values.set !== undefined) {
    try {
      writeConfigFile(configPath, applyAgents(existing, JSON.parse(values.set)));
      json({ ok: true, message: `已写入 ${configPath}（原文件已备份）。之后开始的需求使用新的设置。` });
      return 0;
    } catch (error) {
      json({ ok: false, message: (error as Error).message });
      return 1;
    }
  }

  const settings = {
    daemonUrl: typeof existing.daemonUrl === "string" ? existing.daemonUrl : "ws://127.0.0.1:6767/ws",
    daemonPasswordEnv: typeof existing.daemonPasswordEnv === "string" ? existing.daemonPasswordEnv : "PASEO_DAEMON_PASSWORD",
  };
  if (!values["catalog-json"]) console.log(`配置向导：连接 Paseo daemon ${settings.daemonUrl} ……`);
  let client;
  try {
    // A daemon that is not running must not hold up the installer: give up after 20 seconds.
    let timer: NodeJS.Timeout | undefined;
    client = await Promise.race([
      connect(settings as never),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("20 秒内没有连上")), 20_000);
      }),
    ]).finally(() => clearTimeout(timer));
  } catch (error) {
    const why = `无法连接 daemon：${(error as Error).message}。请确认 Paseo 正在运行；设置了密码时，确认环境变量 ${settings.daemonPasswordEnv} 已设置。`;
    if (values["catalog-json"]) json({ ok: false, message: why });
    else console.error(why);
    return 1;
  }
  const catalog = daemonCatalog(client);
  try {
    if (values["catalog-json"]) {
      const choices = await agentChoices(catalog);
      const auto = await runWizard({}, catalog, recommended).catch(() => null);
      json({ ok: true, current: existing.agents ?? null, choices, recommended: auto ? auto.config.agents : null });
      return 0;
    }
    if (values.auto) {
      const { config, summary } = await runWizard(existing, catalog, recommended);
      writeConfigFile(configPath, config);
      console.log("已按推荐自动选好 agent：");
      for (const line of summary) console.log(`  ${line}`);
      console.log(`写入 ${configPath}。要换：运行 req configure，或在 Paseo 的 设置 → 插件 → req-kit 中修改。`);
      return 0;
    }
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
      writeConfigFile(configPath, config);
      console.log(`\n已写入 ${configPath}（原文件已备份）。接下来运行 npm run smoke -- check 确认两个 agent 能正常工作。`);
      return 0;
    } finally {
      terminal.close();
    }
  } finally {
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
