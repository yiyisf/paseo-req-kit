// Buttons that follow Paseo's agents and workspaces (registered outside React):
//   - a pill on every step agent of a requirement: which requirement, opens it;
//   - a header button on every workspace that has requirements: how many need a person.
import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { listRpc, type Requirement } from "../shared/contracts";
import { inWorkspace } from "./panel";

/** The step agents' labels (req-kit's runtime sets them when it starts a step). */
const PIPELINE_LABEL = "requirement-pipeline";

interface AgentLike {
  id: string;
  workspaceId?: string | null;
  labels?: Record<string, string> | null;
}

interface WorkspaceLike {
  id: string;
  workspaceDirectory?: string;
  projectRootPath?: string;
}

export function contributeLive(client: PluginClientContext): () => void {
  const lifetime = new AbortController();
  const pills = new Map<string, PluginButtonRegistration>();
  const headers = new Map<string, PluginButtonRegistration>();
  const workspaces = new Map<string, WorkspaceLike>();
  let requirements: Requirement[] = [];

  // ----- pills on step agents
  const registerAgent = (agent: AgentLike) => {
    pills.get(agent.id)?.remove();
    pills.delete(agent.id);
    const name = agent.labels?.[PIPELINE_LABEL];
    if (lifetime.signal.aborted || !name || !agent.workspaceId) return;
    pills.set(
      agent.id,
      client.addComposerPill({
        id: "requirement",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: {
          title: `打开需求 ${name}`,
          icon: "ClipboardList",
          label: "需求",
          behavior: { kind: "action", onPress: () => client.openScreen({ screenId: "requirement", params: { name } }) },
        },
      }),
    );
  };
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const pill of pills.values()) pill.remove();
          pills.clear();
          for (const { agent } of entries) registerAgent(agent as AgentLike);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") {
            pills.get(update.agentId)?.remove();
            pills.delete(update.agentId);
          } else registerAgent(update.agent as AgentLike);
        },
      });
      return undefined;
    })
    .catch((error: Error) => {
      if (!lifetime.signal.aborted) console.error("[req-kit] 读取 agent 列表失败", error);
    });

  // ----- header buttons on workspaces with requirements
  const refreshHeaders = () => {
    for (const [id, ws] of workspaces) {
      const mine = inWorkspace(requirements, ws.workspaceDirectory ?? ws.projectRootPath, id);
      const existing = headers.get(id);
      if (mine.length === 0) {
        existing?.remove();
        headers.delete(id);
        continue;
      }
      const waiting = mine.filter((r) => r.attention).length;
      const label = waiting > 0 ? `需求 · 待处理 ${waiting}` : `需求 ${mine.length}`;
      if (existing) existing.update({ label });
      else
        headers.set(
          id,
          client.addHeaderButton({
            id: "requirements",
            workspaceId: id,
            button: {
              title: "这个工作区的需求",
              icon: "ClipboardList",
              label,
              behavior: { kind: "action", onPress: () => client.openPanel("requirements", { workspaceId: id }) },
            },
          }),
        );
    }
    for (const [id, button] of headers) {
      if (!workspaces.has(id)) {
        button.remove();
        headers.delete(id);
      }
    }
  };
  const poll = async () => {
    try {
      requirements = await client.rpc(listRpc, {});
      refreshHeaders();
    } catch {
      // req-kit missing or too old: the overview explains; no header buttons meanwhile.
    }
  };
  let releaseWorkspaces: (() => void) | null = null;
  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ subscription }) => {
      // The workspace list takes no abort signal: release it here or at cleanup.
      releaseWorkspaces = () => void subscription.release().catch(() => undefined);
      if (lifetime.signal.aborted) {
        releaseWorkspaces();
        return undefined;
      }
      subscription.subscribe({
        snapshot: ({ entries }) => {
          workspaces.clear();
          for (const ws of entries) workspaces.set(ws.id, ws as WorkspaceLike);
          refreshHeaders();
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload as { kind: string; workspace?: WorkspaceLike; workspaceId?: string; id?: string };
          if (update.kind === "upsert" && update.workspace) workspaces.set(update.workspace.id, update.workspace);
          else {
            const id = update.workspaceId ?? update.id;
            if (id) workspaces.delete(id);
          }
          refreshHeaders();
        },
      });
      return undefined;
    })
    .catch((error: Error) => {
      if (!lifetime.signal.aborted) console.error("[req-kit] 读取工作区列表失败", error);
    });
  void poll();
  const timer = setInterval(() => void poll(), 30_000);

  return () => {
    lifetime.abort();
    releaseWorkspaces?.();
    clearInterval(timer);
    for (const b of [...pills.values(), ...headers.values()]) b.remove();
    pills.clear();
    headers.clear();
  };
}
