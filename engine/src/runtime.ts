// The narrow surface the pipeline needs from Paseo. The real implementation is
// paseo-runtime.ts; tests swap in a fake through REQ_PIPELINE_FAKE_RUNTIME.

export type AgentRole = "builder" | "reviewer";

export interface PendingPermission {
  id: string;
  title: string;
}

export interface WaitOutcome {
  /** Same values as the SDK's waitForFinish(). */
  status: "idle" | "error" | "permission" | "timeout";
  error: string | null;
  lastMessage: string | null;
  pendingPermissions: PendingPermission[];
  /** Usage the agent reports (its latest snapshot), when the provider reports it. */
  usage?: import("./usage.js").AgentUsage | null;
}

export interface StepAgent {
  readonly id: string;
  /** Waits for the current turn, at most timeoutMs. Returns early on permission requests. */
  wait(timeoutMs: number): Promise<WaitOutcome>;
  /** Starts a new turn in the same session. Call wait() afterwards. */
  followUp(text: string): Promise<void>;
  archive(): Promise<void>;
}

export interface StartAgentInput {
  role: AgentRole;
  title: string;
  prompt: string;
  cwd: string;
  labels: Record<string, string>;
  /** Attach the step agent under this chat agent (shows in its Subagents track). */
  parentAgentId: string | null;
  /** Use this agent instead of the role's configured one (review panel members). */
  profile?: import("./config.js").AgentProfile;
}

export interface AgentRuntime {
  /**
   * Checks that the chat which launched the pipeline exists and works in `cwd`.
   * Step agents are created under that chat, and Paseo gives a subagent its parent's
   * working directory, so the two must match. Throws with a user-facing reason otherwise.
   */
  verifyOrigin(agentId: string, cwd: string): Promise<void>;
  startAgent(input: StartAgentInput): Promise<StepAgent>;
  /** Delivers a message into an existing agent's conversation without interrupting it. */
  notifyAgent(agentId: string, text: string): Promise<void>;
  /** Interrupts the agent's current turn and gives it `text` instead (used to stop a step). */
  interruptAgent(agentId: string, text: string): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeFactoryInput {
  config: import("./config.js").PipelineConfig;
  log: (message: string) => void;
}

export type RuntimeFactory = (input: RuntimeFactoryInput) => Promise<AgentRuntime>;
