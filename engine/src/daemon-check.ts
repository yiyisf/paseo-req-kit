// Checks against the real Paseo daemon, shared by the smoke test and the doctor.

import type { AgentProfile, PipelineConfig } from "./config.js";
import { profilesFromDaemonConfig, resolveConfigProfiles, usesPaseoProfiles } from "./paseo-profiles.js";

export type Report = (level: "ok" | "warn" | "fail", text: string, fix?: string) => void;

export async function connect(config: PipelineConfig) {
  const { createPaseoClient } = await import("@getpaseo/client");
  const password = process.env[config.daemonPasswordEnv];
  const client = createPaseoClient({ url: config.daemonUrl, ...(password ? { password } : {}) });
  const { connectWithin } = await import("./paseo-runtime.js");
  await connectWithin(client, 30_000, config.daemonUrl);
  return client;
}

export type Client = Awaited<ReturnType<typeof connect>>;

/** The config with Paseo profile names resolved against this daemon. Throws ProfileResolutionError. */
export async function resolveWithDaemon(client: Client, config: PipelineConfig): Promise<PipelineConfig> {
  if (!usesPaseoProfiles(config)) return config;
  const daemonConfig = await client.config.get().then((r) => r.config).catch(() => null);
  return resolveConfigProfiles(config, daemonConfig ? profilesFromDaemonConfig(daemonConfig) : null);
}

/** Checks that a role's provider, model and mode exist and will not stop for approvals. */
export async function checkProfile(client: Client, role: string, profile: AgentProfile, report: Report): Promise<boolean> {
  const full = profile.provider ?? "";
  const slash = full.indexOf("/");
  const provider = full.slice(0, slash);
  const model = full.slice(slash + 1);
  const where = `~/.req-kit/config.json 的 agents.${role}`;
  let ok = true;
  try {
    const models = await client.providers.listModels(provider);
    const ids = (models.models ?? []).map((m) => m.id);
    if (ids.includes(model)) {
      report("ok", `${role}：模型 ${profile.provider}`);
    } else {
      ok = false;
      report("fail", `${role}：模型 ${profile.provider} 在 daemon 中不存在`, `修改 ${where}.provider。可用：${ids.map((id) => `${provider}/${id}`).join(", ") || "（无）"}`);
    }
  } catch (error) {
    report("fail", `${role}：无法列出 ${provider} 的模型：${(error as Error).message}`, `确认 Paseo 中已安装并登录 ${provider}`);
    return false;
  }
  // Some providers (e.g. Pi) have no modes and never stop for approvals; they need no modeId.
  try {
    const modes = await client.providers.listModes(provider);
    const ids = (modes.modes ?? []).map((m) => m.id);
    if (ids.length === 0) {
      if (profile.modeId) {
        ok = false;
        report("fail", `${role}：${provider} 没有模式，但配置了 modeId（${profile.modeId}）`, `删除 ${where}.modeId`);
      } else {
        report("ok", `${role}：${provider} 没有模式，不需要 modeId`);
      }
    } else if (!profile.modeId) {
      ok = false;
      report("fail", `${role}：没有设置 modeId，agent 可能会停下来等待权限批准`, `设置 ${where}.modeId，可用：${ids.join(", ")}`);
    } else if (!ids.includes(profile.modeId)) {
      ok = false;
      report("fail", `${role}：模式 ${profile.modeId} 不存在`, `修改 ${where}.modeId，可用：${ids.join(", ")}`);
    } else if (provider === "opencode" && profile.featureValues?.auto_accept !== true) {
      ok = false;
      report("fail", `${role}：OpenCode 没有开启自动接受，会停下来等待权限批准`, `在 ${where} 中加上 "featureValues": { "auto_accept": true }`);
    } else {
      report("ok", `${role}：模式 ${profile.modeId}`);
    }
  } catch (error) {
    ok = false;
    report("fail", `${role}：无法列出 ${provider} 的模式：${(error as Error).message}`);
  }
  return ok;
}

/** Minimal "x.y.z satisfies '>=a.b.c <d.e.f'" for the ranges req-kit declares. */
export function satisfies(version: string, range: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(/[-+]/)[0].split(".").map((n) => Number(n) || 0);
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i += 1) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  const v = parse(version);
  return range
    .trim()
    .split(/\s+/)
    .every((part) => {
      const match = /^(>=|<=|>|<|=)?(.+)$/.exec(part);
      if (!match) return false;
      const c = cmp(v, parse(match[2]));
      switch (match[1] ?? "=") {
        case ">=":
          return c >= 0;
        case "<=":
          return c <= 0;
        case ">":
          return c > 0;
        case "<":
          return c < 0;
        default:
          return c === 0;
      }
    });
}
