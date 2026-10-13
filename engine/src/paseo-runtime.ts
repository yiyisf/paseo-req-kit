import type { PaseoAgentHandle, PaseoClient } from "@getpaseo/client";
import { summarizeActivity } from "./activity.js";
import { type AgentProfile, isResolved, type PipelineConfig } from "./config.js";
import { profilesFromDaemonConfig } from "./paseo-profiles.js";
import { samePath } from "./paths.js";
import type { AgentRuntime, ManagedService, ProviderQuota, RuntimeFactory, ServiceTarget, StepAgent, WaitOutcome } from "./runtime.js";

// Checked against @getpaseo/client 0.11.2 (packages/client/src/index.ts) and the
// daemon (packages/server/src/server/session.ts, agent/create-agent/intent.ts):
// - agents.create({ config: { provider: "provider/model", modeId }, cwd, title, labels, prompt, parent })
//   With `parent`, the daemon places the agent in the parent's workspace AND uses the
//   parent's cwd; the requested cwd is ignored. The pipeline therefore requires the chat's
//   cwd to be the repository (verifyOrigin), and verifies every created agent's cwd.
//   SDK-created subagents do not post finish notifications to the parent.
// - handle.waitForFinish(timeoutMs) -> { status: idle|error|permission|timeout, final, error, lastMessage }
//   The daemon answers immediately when the agent is already idle or has a pending permission.
// - handle.send(text, { activeTurnBehavior }) -> the daemon interrupts a running turn
//   unless activeTurnBehavior is "steer".
// - config.get() -> { config: { agentProfiles?: AgentProfile[], mcp, browserTools, ... } }
// - providers.listUsage() -> { providers: [{ providerId, displayName, windows: [{ label, usedPct, resetsAt, tone }] }] }
// - agent.timeline.refetch({ direction: "tail", limit }) -> { entries: [{ timestamp, item }] }
// - Workspace scripts (paseo.json) are not on the public client in 0.11; they are reached
//   through the exported internal DaemonClient (listWorkspaceScripts, startWorkspaceScriptWithStatus,
//   stopWorkspaceScript). See WorkspaceScripts below; every use degrades to "not available".

export type SdkClient = Pick<PaseoClient, "agents" | "close"> &
  Partial<Pick<PaseoClient, "config" | "providers" | "terminals" | "workspaces">>;

/** paseo.json scripts as the daemon reports them (protocol WorkspaceScriptPayloadSchema). */
export interface ScriptInfo {
  scriptName: string;
  type?: "script" | "service";
  port: number | null;
  proxyUrl?: string | null;
  localProxyUrl?: string | null;
  lifecycle: "running" | "stopped";
  health: "healthy" | "unhealthy" | null;
  exitCode?: number | null;
  terminalId?: string | null;
}

export interface WorkspaceScripts {
  list(workspaceId: string): Promise<ScriptInfo[]>;
  start(workspaceId: string, name: string): Promise<void>;
  stop(workspaceId: string, name: string): Promise<void>;
  /** paseo.json setup of a new worktree; null when the daemon does not report one. */
  setupStatus(workspaceId: string): Promise<{ status: "running" | "completed" | "failed" | "blocked"; error: string | null } | null>;
  close(): Promise<void>;
}

export { samePath };

function agentConfig(profile: AgentProfile) {
  if (!isResolved(profile)) {
    throw new Error(`agent 配置没有 provider${profile.paseoProfile ? `（Paseo profile「${profile.paseoProfile}」没有解析）` : ""}`);
  }
  return {
    provider: profile.provider,
    ...(profile.modeId ? { modeId: profile.modeId } : {}),
    ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
    ...(profile.featureValues ? { featureValues: profile.featureValues } : {}),
    ...(profile.options ? { options: profile.options as Record<string, never> } : {}),
  };
}

function wrap(handle: PaseoAgentHandle): StepAgent {
  return {
    id: handle.id,
    async wait(timeoutMs: number): Promise<WaitOutcome> {
      const result = await handle.waitForFinish(timeoutMs);
      const pending = result.final?.pendingPermissions ?? [];
      return {
        status: result.status,
        error: result.error,
        lastMessage: result.lastMessage,
        pendingPermissions: pending.map((p) => ({
          id: p.id,
          title: p.title ?? p.description ?? p.name,
        })),
        usage: result.final?.lastUsage ?? null,
      };
    },
    async followUp(text: string): Promise<void> {
      await handle.send(text);
    },
    async archive(): Promise<void> {
      await handle.archive();
    },
  };
}

async function agentCwd(handle: PaseoAgentHandle): Promise<string | null> {
  const fetched = await handle.refresh();
  return fetched?.agent.cwd ?? null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createRuntimeWithClient(
  client: SdkClient,
  config: PipelineConfig,
  log: (message: string) => void,
  scriptsFactory: (() => Promise<WorkspaceScripts | null>) | null = null,
): AgentRuntime {
  let scripts: Promise<WorkspaceScripts | null> | null = null;
  const getScripts = () => {
    scripts ??= (scriptsFactory ? scriptsFactory() : Promise.resolve(null)).catch((error: Error) => {
      log(`无法使用 Paseo 的工作区脚本：${error.message}`);
      return null;
    });
    return scripts;
  };
  const workspaceOf = async (target: ServiceTarget): Promise<string | null> => {
    if ("workspaceId" in target) return target.workspaceId;
    const fetched = await client.agents.ref(target.agentId).refresh().catch(() => null);
    return fetched?.agent.workspaceId ?? null;
  };
  const tail = async (terminalId: string | null | undefined): Promise<string | null> => {
    if (!terminalId || !client.terminals) return null;
    try {
      const captured = await client.terminals.ref(terminalId).capture({ stripAnsi: true });
      return captured.lines.slice(-60).join("\n").trim() || null;
    } catch {
      return null;
    }
  };
  const toService = async (info: ScriptInfo): Promise<ManagedService> => ({
    name: info.scriptName,
    url: info.proxyUrl ?? info.localProxyUrl ?? (info.port ? `http://127.0.0.1:${info.port}` : null),
    port: info.port,
    running: info.lifecycle === "running",
    health: info.health ?? null,
    exitCode: info.exitCode ?? null,
    output: await tail(info.terminalId),
  });

  return {
    async verifyOrigin(agentId, cwd) {
      let originCwd: string | null;
      try {
        originCwd = await agentCwd(client.agents.ref(agentId));
      } catch (error) {
        throw new Error(`无法读取发起对话的 agent ${agentId}：${(error as Error).message}`);
      }
      if (originCwd === null) {
        throw new Error(`找不到发起对话的 agent ${agentId}（可能已被归档）。请在需求所在项目的对话中重新启动。`);
      }
      if (!samePath(originCwd, cwd)) {
        throw new Error(
          `发起对话的工作目录是 ${originCwd}，与仓库目录 ${cwd} 不一致。` +
            "步骤 agent 会挂在发起的对话下、使用对话的工作目录，所以流水线必须在该仓库对应的项目对话中启动。",
        );
      }
    },
    async startAgent(input) {
      const base = {
        config: agentConfig(input.profile ?? config.agents[input.role]),
        cwd: input.cwd,
        title: input.title,
        labels: input.labels,
        prompt: input.prompt,
      };
      let handle: PaseoAgentHandle;
      if (input.workspaceId) {
        // The requirement's own worktree: placed there, still a subagent of the chat.
        if (!client.workspaces) throw new Error("这个 Paseo 版本不支持把 agent 放进指定的工作区");
        const { cwd: _cwd, ...placed } = base;
        handle = await client.workspaces.ref(input.workspaceId).agents.create({
          ...placed,
          ...(input.parentAgentId ? { parent: input.parentAgentId } : {}),
        });
      } else {
        handle = input.parentAgentId
          ? await client.agents.create({ ...base, parent: input.parentAgentId })
          : await client.agents.create(base);
      }

      // Guard against the daemon placing the agent anywhere but the repository.
      const actual = await agentCwd(handle).catch(() => null);
      if (actual !== null && !samePath(actual, input.cwd)) {
        await handle.archive().catch(() => undefined);
        throw new Error(`新建的 agent 工作目录是 ${actual}，不是仓库目录 ${input.cwd}，已停止该 agent`);
      }
      return wrap(handle);
    },
    async notifyAgent(agentId, text) {
      await client.agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
    },
    async interruptAgent(agentId, text) {
      await client.agents.ref(agentId).send(text, { activeTurnBehavior: "interrupt" });
    },
    async listPaseoProfiles() {
      if (!client.config) return null;
      try {
        return profilesFromDaemonConfig((await client.config.get()).config);
      } catch (error) {
        log(`无法读取 Paseo 的 agent profiles：${(error as Error).message}`);
        return null;
      }
    },
    async listServices(target) {
      const api = await getScripts();
      const workspaceId = api ? await workspaceOf(target) : null;
      if (!api || !workspaceId) return null;
      try {
        const services = (await api.list(workspaceId)).filter((s) => (s.type ?? "service") === "service").map((s) => s.scriptName);
        return services.length ? services : null;
      } catch (error) {
        log(`无法列出工作区脚本：${(error as Error).message}`);
        return null;
      }
    },
    async startServices(target, names, readyTimeoutMs) {
      const api = await getScripts();
      const workspaceId = await workspaceOf(target);
      if (!api || !workspaceId) throw new Error("无法使用 Paseo 的工作区脚本");
      const current = await api.list(workspaceId);
      for (const name of names) {
        // Stop first so the service runs the code as it is now.
        if (current.find((s) => s.scriptName === name)?.lifecycle === "running") await api.stop(workspaceId, name);
        await api.start(workspaceId, name);
      }
      const deadline = Date.now() + readyTimeoutMs;
      let latest = await api.list(workspaceId);
      for (;;) {
        const wanted = latest.filter((s) => names.includes(s.scriptName));
        const settled = wanted.every((s) => s.lifecycle === "stopped" || s.health === "healthy");
        if (settled || Date.now() >= deadline) break;
        await sleep(2000);
        latest = await api.list(workspaceId);
      }
      return Promise.all(latest.filter((s) => names.includes(s.scriptName)).map(toService));
    },
    async stopServices(target, names) {
      const api = await getScripts();
      const workspaceId = await workspaceOf(target);
      if (!api || !workspaceId) return;
      const current = await api.list(workspaceId).catch(() => []);
      for (const name of names) {
        if (current.find((s) => s.scriptName === name)?.lifecycle !== "running") continue;
        await api.stop(workspaceId, name).catch((error: Error) => log(`停止服务 ${name} 失败：${error.message}`));
      }
    },
    async providerQuota(providers) {
      if (!client.providers) return null;
      try {
        const usage = await client.providers.listUsage();
        const quotas: ProviderQuota[] = [];
        for (const p of usage.providers) {
          if (!providers.includes(p.providerId) || p.status !== "available") continue;
          for (const w of p.windows) {
            quotas.push({
              provider: p.providerId,
              displayName: p.displayName,
              window: w.label,
              usedPct: w.usedPct ?? (typeof w.remainingPct === "number" ? 100 - w.remainingPct : null),
              resetsAt: w.resetsAt ?? null,
              tone: w.tone ?? null,
            });
          }
        }
        return quotas.length ? quotas : null;
      } catch {
        return null;
      }
    },
    async recentActivity(agentId, limit) {
      try {
        const page = await client.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: Math.max(limit * 4, 20) });
        return summarizeActivity(page.entries, limit);
      } catch {
        return null;
      }
    },
    async createWorktree(request) {
      if (!client.workspaces) throw new Error("这个 Paseo 版本不支持新建工作区");
      const workspace = await client.workspaces.create({
        source: { kind: "worktree", cwd: request.sourceRepo, action: "branch-off", refName: request.baseRef, branchName: request.branchName },
        title: request.title,
        background: false,
        ...(request.callerAgentId ? { callerAgentId: request.callerAgentId } : {}),
      });
      const directory = workspace.directory ?? (await workspace.refresh())?.workspaceDirectory ?? null;
      if (!directory) throw new Error("Paseo 没有返回新工作区的目录");
      return { workspaceId: workspace.id, directory };
    },
    async waitForWorkspaceSetup(workspaceId, timeoutMs) {
      const api = await getScripts();
      if (!api) return { status: "none", error: null };
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const snapshot = await api.setupStatus(workspaceId).catch(() => null);
        if (!snapshot) return { status: "none", error: null };
        if (snapshot.status === "completed") return { status: "completed", error: null };
        if (snapshot.status === "failed" || snapshot.status === "blocked") return { status: "failed", error: snapshot.error ?? snapshot.status };
        if (Date.now() >= deadline) return { status: "timeout", error: null };
        await sleep(3000);
      }
    },
    async capabilities() {
      if (!client.config) return null;
      try {
        const daemonConfig = (await client.config.get()).config as { mcp?: { injectIntoAgents?: boolean }; browserTools?: { enabled?: boolean } };
        const paseoTools = daemonConfig.mcp?.injectIntoAgents === true;
        return { paseoTools, browser: paseoTools && daemonConfig.browserTools?.enabled === true };
      } catch {
        return null;
      }
    },
    async close() {
      if (scripts) await (await scripts)?.close().catch(() => undefined);
      await client.close();
    },
  };
}

export const createRuntime: RuntimeFactory = async ({ config, log }) => {
  // Loaded lazily so the runtime logic can be tested without the SDK installed.
  const { createPaseoClient } = await import("@getpaseo/client");
  const password = process.env[config.daemonPasswordEnv];
  const client = createPaseoClient({
    url: config.daemonUrl,
    ...(password ? { password } : {}),
    reconnect: { enabled: true },
  });
  await client.connect();
  return createRuntimeWithClient(client, config, log, () => connectScripts(config));
};

/** Workspace scripts through the internal DaemonClient that @getpaseo/client 0.11 exports. */
async function connectScripts(config: PipelineConfig): Promise<WorkspaceScripts | null> {
  const internal = (await import("@getpaseo/client/internal/daemon-client").catch(() => null)) as
    | { DaemonClient?: new (options: Record<string, unknown>) => InternalDaemonClient }
    | null;
  if (!internal?.DaemonClient) return null;
  const password = process.env[config.daemonPasswordEnv];
  const daemon = new internal.DaemonClient({
    url: config.daemonUrl,
    clientId: `req-kit-${process.pid}-${Date.now().toString(36)}`,
    clientType: "cli",
    ...(password ? { password } : {}),
    reconnect: { enabled: true },
  });
  if (typeof daemon.listWorkspaceScripts !== "function") return null;
  await daemon.connect();
  const check = (payload: { error: string | null }) => {
    if (payload.error) throw new Error(payload.error);
  };
  return {
    async list(workspaceId) {
      const payload = await daemon.listWorkspaceScripts(workspaceId);
      check(payload);
      return (payload.scripts ?? []) as ScriptInfo[];
    },
    async start(workspaceId, name) {
      check(await daemon.startWorkspaceScriptWithStatus(workspaceId, name));
    },
    async stop(workspaceId, name) {
      check(await daemon.stopWorkspaceScript(workspaceId, name));
    },
    async setupStatus(workspaceId) {
      if (typeof daemon.fetchWorkspaceSetupStatus !== "function") return null;
      const payload = await daemon.fetchWorkspaceSetupStatus(workspaceId);
      return payload.snapshot ? { status: payload.snapshot.status, error: payload.snapshot.error } : null;
    },
    async close() {
      await daemon.close();
    },
  };
}

interface InternalDaemonClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  listWorkspaceScripts(workspaceId: string): Promise<{ scripts?: unknown[]; error: string | null }>;
  startWorkspaceScriptWithStatus(workspaceId: string, name: string): Promise<{ error: string | null }>;
  stopWorkspaceScript(workspaceId: string, name: string): Promise<{ error: string | null }>;
  fetchWorkspaceSetupStatus?(
    workspaceId: string,
  ): Promise<{ snapshot: { status: "running" | "completed" | "failed" | "blocked"; error: string | null } | null }>;
}
