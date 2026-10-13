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
  /** Place the agent in this Paseo workspace (a worktree created for the requirement); still a subagent of parentAgentId. */
  workspaceId?: string | null;
}

/** Where Paseo-managed services live: the chat's workspace, or the requirement's own worktree. */
export type ServiceTarget = { agentId: string } | { workspaceId: string };

export interface WorktreeRequest {
  /** Checkout to cut the worktree from (the chat's directory). */
  sourceRepo: string;
  /** Branch or commit the new branch starts from. */
  baseRef: string;
  branchName: string;
  title: string;
  /** The chat; Paseo shows the workspace as created from it. */
  callerAgentId: string | null;
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

export interface ScheduledMessage {
  agentId: string;
  name: string;
  prompt: string;
  /** One run at this time; or `cron` for a recurring one. */
  at?: Date;
  cron?: string;
  /** Recurring schedules stop by themselves at this time. */
  expiresAt?: Date;
}

export interface ScheduledAgent {
  name: string;
  prompt: string;
  cron: string;
  cwd: string;
  profile: import("./config.js").AgentProfile;
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
  listServices(target: ServiceTarget): Promise<string[] | null>;
  /** (Re)starts the services so they run the current code, and waits until they are ready or failed. */
  startServices(target: ServiceTarget, names: string[], readyTimeoutMs: number): Promise<ManagedService[]>;
  stopServices(target: ServiceTarget, names: string[]): Promise<void>;
  /** Creates a Paseo worktree workspace (paseo.json setup runs in the background). */
  createWorktree(request: WorktreeRequest): Promise<{ workspaceId: string; directory: string }>;
  /** Waits for the workspace's paseo.json setup; "none" when there is nothing to wait for or it cannot be read. */
  waitForWorkspaceSetup(workspaceId: string, timeoutMs: number): Promise<{ status: "completed" | "failed" | "none" | "timeout"; error: string | null }>;
  /** Subscription windows of the given providers; null when Paseo has no usage data. */
  providerQuota(providers: string[]): Promise<ProviderQuota[] | null>;
  /** The agent's latest actions, oldest first; null when they cannot be read. */
  recentActivity(agentId: string, limit: number): Promise<ActivityItem[] | null>;
  /** Which Paseo tools step agents get (Settings → Agents); null when unknown. */
  capabilities(): Promise<{ paseoTools: boolean; browser: boolean } | null>;
  /**
   * Paseo schedule that sends `prompt` into an existing agent's conversation (the chat):
   * once at `at`, or on `cron` (5 fields, local time zone). Returns the schedule ID, or
   * null when this Paseo cannot schedule.
   */
  scheduleMessage(input: ScheduledMessage): Promise<string | null>;
  /** Paseo schedule that starts a fresh agent on `cron` (e.g. to run a command weekly). */
  scheduleNewAgent(input: ScheduledAgent): Promise<string | null>;
  cancelSchedule(id: string): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeFactoryInput {
  config: import("./config.js").PipelineConfig;
  log: (message: string) => void;
}

export type RuntimeFactory = (input: RuntimeFactoryInput) => Promise<AgentRuntime>;
