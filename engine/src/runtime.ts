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
  /** Agent settings to launch with (the role's, or a review panel member's), Paseo profiles resolved. */
  profile?: import("./config.js").AgentProfile;
}

/** A paseo.json service the pipeline runs through Paseo (supervised, own port per worktree). */
export interface ManagedService {
  name: string;
  /** Address to use: Paseo's proxy URL when there is one, otherwise http://127.0.0.1:<port>. */
  url: string | null;
  port: number | null;
  running: boolean;
  health: "healthy" | "unhealthy" | null;
  exitCode: number | null;
  /** Last lines of the service's terminal, when they could be read. */
  output: string | null;
}

/** One subscription window of a provider (Paseo's provider usage), e.g. "5 小时" at 92%. */
export interface ProviderQuota {
  provider: string;
  displayName: string;
  window: string;
  usedPct: number | null;
  resetsAt: string | null;
  tone: "default" | "ok" | "warning" | "danger" | null;
}

/** A recent thing an agent did, in plain words, e.g. "运行命令：npm test". */
export interface ActivityItem {
  at: string;
  text: string;
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
  /** The daemon's agent profiles (Paseo settings → Agent profiles); null when they cannot be read. */
  listPaseoProfiles(): Promise<import("./paseo-profiles.js").PaseoProfile[] | null>;
  /**
   * Names of the service scripts (paseo.json) of the workspace the chat works in. Null when
   * Paseo cannot run them for us: no chat, an older daemon, or no services configured.
   */
  listServices(originAgentId: string): Promise<string[] | null>;
  /** (Re)starts the services so they run the current code, and waits until they are ready or failed. */
  startServices(originAgentId: string, names: string[], readyTimeoutMs: number): Promise<ManagedService[]>;
  stopServices(originAgentId: string, names: string[]): Promise<void>;
  /** Subscription windows of the given providers; null when Paseo has no usage data. */
  providerQuota(providers: string[]): Promise<ProviderQuota[] | null>;
  /** The agent's latest actions, oldest first; null when they cannot be read. */
  recentActivity(agentId: string, limit: number): Promise<ActivityItem[] | null>;
  close(): Promise<void>;
}

export interface RuntimeFactoryInput {
  config: import("./config.js").PipelineConfig;
  log: (message: string) => void;
}

export type RuntimeFactory = (input: RuntimeFactoryInput) => Promise<AgentRuntime>;
