import type { PaseoAgentHandle, PaseoClient } from "@getpaseo/client";
import type { AgentProfile, PipelineConfig } from "./config.js";
import { samePath } from "./paths.js";
import type { AgentRuntime, RuntimeFactory, StepAgent, WaitOutcome } from "./runtime.js";

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

export type SdkClient = Pick<PaseoClient, "agents" | "close">;

export { samePath };

function agentConfig(profile: AgentProfile) {
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

export function createRuntimeWithClient(
  client: SdkClient,
  config: PipelineConfig,
  _log: (message: string) => void,
): AgentRuntime {
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
      const handle = input.parentAgentId
        ? await client.agents.create({ ...base, parent: input.parentAgentId })
        : await client.agents.create(base);

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
    async close() {
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
  return createRuntimeWithClient(client, config, log);
};
