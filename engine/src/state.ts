import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DefectHandling, PhaseMode, ProfileName, RequirementType, VerifyEnvironment } from "./config.js";
import type { ExternalRecord } from "./integrations.js";
import { registerRequirement } from "./records.js";
import type { AgentUsage } from "./usage.js";
import type { StepId } from "./steps.js";

/**
 * "phase_done": the develop phase is done and the run stopped at the gate, waiting for
 * someone to start the verify phase (phases.mode "gated"). Engines before 1.7 treat an
 * unknown status as an interrupted run, which continues into verification: acceptable.
 * "waiting_for_approval" (1.8): the design waits for the requester's confirmation
 * (designApproval); older engines continue as after an interruption, i.e. without it.
 */
export type PipelineStatus = "running" | "waiting_for_business" | "failed" | "completed" | "phase_done" | "waiting_for_approval";

/** Phase names are strings so later phases need no format change. */
export type PhaseName = "develop" | "verify";

/** Execution mode and verify-phase options a run settled on (absent before 1.7: continuous). */
export interface RunPhases {
  mode: PhaseMode;
  environment: VerifyEnvironment;
  defects: DefectHandling;
}

/**
 * Why a run stopped for a person (1.12). Necessary decisions: approval (the plan), business
 * (a question only the requester can answer), reproduce (a defect that could not be reproduced),
 * phase_gate (development done, waiting for testing). The rest are interruptions.
 */
export type StopKind =
  | "approval"
  | "business"
  | "reproduce"
  | "phase_gate"
  | "timeout"
  | "agent_error"
  | "invalid_result"
  | "transient"
  | "stopped"
  | "process_exit"
  | "budget"
  | "other";

/** Something the pipeline handled by itself (1.12). */
export interface Recovery {
  at: string;
  key: string;
  kind: "retry" | "reattach" | "reuse_result" | "extend_timeout" | "redo" | "fallback" | "auto_resume" | "quota_wait" | "self_answer";
  detail: string;
}

export interface StepRecord {
  key: string;
  stepId: StepId;
  round: number | null;
  attempt: number;
  agentId: string;
  startedAt: string;
  endedAt: string | null;
  outcome: "running" | "completed" | "failed";
  followUps: number;
  result: Record<string, unknown> | null;
  error: string | null;
  /** Latest usage the agent reported for this step; absent in older state files. */
  usage?: AgentUsage | null;
  /** Phase the step ran in; absent before 1.7 (develop or verify by step). */
  phase?: PhaseName;
  /**
   * 1.11: the step failed while its agent was still at work (timed out, or its status could
   * not be read). The next run of the step checks that agent before starting another one.
   */
  leftRunning?: boolean;
  /** 1.11: how many times a later run went on waiting for this record's agent instead of starting a new one. */
  reattached?: number;
  /** 1.12.1: the step's time limit was already given its one extra period (selfHeal); a later run waiting for the same agent gets none. */
  extendedTimeout?: boolean;
  /** 1.13: the agent the step ran with: the Paseo profile name, or "provider/model". */
  agent?: string;
}

/** 1.13: the requirement's token budget so far (config budget). */
export interface BudgetState {
  /** Tokens allowed before stopping: the budget, plus one more each time the person continued after a stop. */
  allowance: number;
  /** The allowance a warning was given for, so each level warns once. */
  warnedAt: number | null;
}

export interface PipelineState {
  /** Format version, see STATE_VERSION. */
  version: number;
  repo: string;
  featureDir: string;
  status: PipelineStatus;
  /** Incremented every time the pipeline starts over from the design step. */
  attempt: number;
  specHash: string;
  originAgentId: string | null;
  pid: number;
  startedAt: string;
  updatedAt: string;
  /** Completed step results by step key. A resumed run reuses these instead of re-running the step. */
  results: Record<string, Record<string, unknown>>;
  history: StepRecord[];
  stopReason: string | null;
  /** 1.13: a step agent is waiting for someone to allow or deny an action; null otherwise. */
  waitingPermission?: { agentId: string; stepTitle: string; requests: string[]; since: string } | null;
  /** 1.13: token budget (config budget); absent until the first check. */
  budget?: BudgetState;
  /** 1.12: why the run stopped for a person, as a code (contracts/usage-record.md); null while running or done. */
  stopKind?: StopKind | null;
  /** 1.12: what the pipeline handled by itself instead of stopping (retries, waiting longer, a fallback model…). */
  recoveries?: Recovery[];
  /** 1.12: the questions a run waiting for the requester (waiting_for_business) asks; cleared when it runs again. */
  pendingQuestions?: string[] | null;
  outcome: string | null;
  /** "quick" or "standard"; decides loop rounds and optional steps. */
  profile: ProfileName;
  /** Git branch the run commits to, fixed at launch. Null outside a git repository. */
  branch: string | null;
  /** Progress notes already sent, so a resumed run does not repeat them. */
  milestones: string[];
  /**
   * Set when this attempt restarted from design because the requirement changed (or a
   * business decision was answered): the steps build on the existing design and code
   * instead of starting over. Absent in older state files.
   */
  incremental?: IncrementalInfo | null;
  /**
   * Set when the requirement is developed in a worktree created for it (--worktree):
   * the Paseo workspace and the checkout the chat works in. `repo` is the worktree.
   */
  worktree?: { workspaceId: string; sourceRepo: string } | null;
  /** Paseo schedules this run created (reminders, automatic continuation, watchdog); cancelled by the next run. */
  schedules?: Array<{ id: string; kind: "reminder" | "auto-resume" | "watchdog" | "verify-start" | "approval-continue"; at: string | null }>;
  /** Automatic continuations used in this attempt. */
  autoResumes?: { attempt: number; count: number } | null;
  /** Set while waiting for a free slot (maxConcurrentPipelines). */
  queuedSince?: string | null;
  /** Execution mode of this run; absent in older state files (continuous). */
  phases?: RunPhases | null;
  /** Current phase; absent in older state files. */
  phase?: PhaseName;
  /** --verify-at: when the verify phase should start once development is done (ISO time). */
  verifyAt?: string | null;
  /** How many times the verify phase handed defects back to development (defects "handback"). */
  handbacks?: number;
  /** Requirement type with its own playbook, from the spec's "类型" line; absent: the normal flow (1.8). */
  type?: RequirementType | null;
  /** Commit before the attempt's first code change; the quality gate's baseline and the scope check start here (1.8). */
  codeBase?: { attempt: number; commit: string | null } | null;
  /**
   * Joint requirement (1.8): other repositories this requirement also changes, each in a
   * worktree created for it, with its own code base and quality gate. See ADR 0025.
   */
  joint?: JointRepo[] | null;
  /** Design confirmation point (1.8): which attempt's design is waiting or was confirmed. */
  approval?: { attempt: number; status: "waiting" | "approved"; at: string; auto?: boolean } | null;
  /** Quality gate: the checks' results before the change, and every run after a step (1.8). */
  gate?: { baseline: GateBaseline | null; runs: GateRun[] } | null;
  /** External systems (1.9): the requirement's card in each, by integration name. */
  external?: Record<string, ExternalRecord> | null;
  /**
   * Branches pushed for a requirement that started from a card (1.10, `push` config): one entry
   * per repository (the main one, then joint ones), the latest attempt. `error` is null when it worked.
   */
  pushed?: Array<{
    repo: string;
    remote: string;
    branch: string;
    at: string;
    error: string | null;
    /** 1.12: the draft merge request made after the push (push.mergeRequest); made once per repository. */
    mergeRequest?: { url: string | null; at: string; error: string | null } | null;
  }> | null;
}

export interface JointRepo {
  /** Name in relatedRepos, e.g. "后端". */
  name: string;
  /** ASCII key suffix for its steps ("implement@backend"). */
  slug: string;
  /** The checkout the worktree was cut from. */
  sourceRepo: string;
  /** The worktree the steps work in. */
  repo: string;
  workspaceId: string;
  branch: string;
  /** Hash of the spec last copied there. */
  specHash: string | null;
  codeBase?: { attempt: number; commit: string | null } | null;
  gate?: { baseline: GateBaseline | null; runs: GateRun[] } | null;
}

export type CheckOutcome = "pass" | "fail";

export interface GateBaseline {
  attempt: number;
  commit: string | null;
  at: string;
  results: Record<string, CheckOutcome>;
}

export interface GateRun {
  /** Step key the checks ran after, e.g. "implement-s2", "review_fix-r1". */
  key: string;
  attempt: number;
  at: string;
  /** Checks that applied to the change; "skipped" ones did not touch their paths. */
  checks: Array<{ name: string; result: CheckOutcome | "skipped"; failedBefore: boolean }>;
  /** Checks that pass before the change and fail after it: these block. */
  newFailures: string[];
  /** Times the step agent was asked to fix them. */
  fixRounds: number;
  passed: boolean;
}

export interface IncrementalInfo {
  /** Attempt whose work this one continues. */
  fromAttempt: number;
  reason: string;
  /** Commit at the start of this attempt; reviewers look at changes since here. Null outside git. */
  baseCommit: string | null;
  /** Whether the previous attempt got as far as writing code. */
  hadImplementation: boolean;
}

export function pipelineDir(repo: string, featureDir: string): string {
  return path.join(repo, featureDir, ".pipeline");
}

export function statePath(repo: string, featureDir: string): string {
  return path.join(pipelineDir(repo, featureDir), "state.json");
}

export function ensurePipelineDir(repo: string, featureDir: string): string {
  const dir = pipelineDir(repo, featureDir);
  fs.mkdirSync(path.join(dir, "results"), { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  // Runtime files only; never committed by the step agents.
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  return dir;
}

/**
 * Format version of state.json written by this engine. Bump it when the shape changes
 * and add a migration from the previous version to STATE_MIGRATIONS.
 */
export const STATE_VERSION = 1;

/** Upgrades a state object from version `n` to `n + 1`. */
export type StateMigration = (state: Record<string, unknown>) => Record<string, unknown>;

/** Keyed by the version a migration upgrades from. */
export const STATE_MIGRATIONS: Record<number, StateMigration> = {};

export class StateVersionError extends Error {
  constructor(file: string, found: number, supported: number) {
    super(
      `${file} 是由更新版本的 req-kit 写入的（格式第 ${found} 版，当前版本只支持到第 ${supported} 版）。` +
        "请升级 req-kit 后再操作；如果是回滚到旧版本造成的，可以把同目录下的 state.json.bak-v<旧版本号> 恢复为 state.json，" +
        "或者删除 state.json 后用 --restart 从头开始。",
    );
    this.name = "StateVersionError";
  }
}

/**
 * Brings a parsed state object up to `target`, one version at a time.
 * Files written before the version field existed count as version 1.
 */
export function migrateState(
  raw: Record<string, unknown>,
  file: string,
  migrations: Record<number, StateMigration> = STATE_MIGRATIONS,
  target: number = STATE_VERSION,
): { state: Record<string, unknown>; from: number } {
  const from = typeof raw.version === "number" ? raw.version : 1;
  if (from > target) throw new StateVersionError(file, from, target);
  let state = raw;
  for (let version = from; version < target; version += 1) {
    const step = migrations[version];
    if (!step) throw new Error(`缺少 state.json 从第 ${version} 版到第 ${version + 1} 版的迁移`);
    state = { ...step(state), version: version + 1 };
  }
  return { state, from };
}

/**
 * Reads state.json, migrating an older format in place. The file as it was is kept
 * next to it as state.json.bak-v<old version>, so a rollback can restore it.
 */
export function readState(
  file: string,
  migrations: Record<number, StateMigration> = STATE_MIGRATIONS,
  target: number = STATE_VERSION,
): PipelineState | null {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  const raw = JSON.parse(text) as Record<string, unknown>;
  const { state, from } = migrateState(raw, file, migrations, target);
  if (from < target) {
    const backup = `${file}.bak-v${from}`;
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, text);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmp, file);
  }
  return state as unknown as PipelineState;
}

/**
 * 1.12.1: replaces `file` with `tmp`. On Windows a virus scanner or the search indexer may hold
 * the file for a moment (EPERM / EBUSY / EACCES): try again a few times before giving up.
 */
export function replaceFile(tmp: string, file: string, retryDelaysMs: readonly number[] = [20, 50, 100, 200, 400]): void {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (i >= retryDelaysMs.length || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryDelaysMs.at(i));
    }
  }
}

export function writeState(file: string, state: PipelineState): void {
  state.updatedAt = new Date().toISOString();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  replaceFile(tmp, file);
  // The machine's index of requirements (1.9): written once, and again only if it moved.
  registerRequirement(state);
}

export function hashFile(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// ---------------------------------------------------------------------------
// One pipeline per repository checkout: the steps switch branches and commit,
// so two pipelines in the same directory would corrupt each other's work.
// ---------------------------------------------------------------------------

export interface LockInfo {
  pid: number;
  featureDir: string;
  startedAt: string;
}

export function lockPath(repo: string): string {
  const id = crypto.createHash("sha1").update(fs.realpathSync(repo)).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), `requirement-pipeline-${id}.lock`);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Returns the live holder of the repository lock, or null. Removes a stale lock. */
export function currentLockHolder(repo: string): LockInfo | null {
  const file = lockPath(repo);
  if (!fs.existsSync(file)) return null;
  try {
    const info = JSON.parse(fs.readFileSync(file, "utf8")) as LockInfo;
    if (isAlive(info.pid)) return info;
  } catch {
    // Unreadable lock: treat as stale.
  }
  fs.rmSync(file, { force: true });
  return null;
}

export function acquireLock(repo: string, featureDir: string): () => void {
  const file = lockPath(repo);
  const holder = currentLockHolder(repo);
  if (holder && holder.pid !== process.pid) {
    throw new LockHeldError(holder);
  }
  const info: LockInfo = { pid: process.pid, featureDir, startedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(file, JSON.stringify(info), { flag: holder ? "w" : "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const other = currentLockHolder(repo);
      if (other) throw new LockHeldError(other);
      fs.writeFileSync(file, JSON.stringify(info), { flag: "wx" });
    } else {
      throw error;
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const now = JSON.parse(fs.readFileSync(file, "utf8")) as LockInfo;
      if (now.pid === process.pid) fs.rmSync(file, { force: true });
    } catch {
      // Already gone.
    }
  };
}

export class LockHeldError extends Error {
  constructor(public readonly holder: LockInfo) {
    super(
      `这个仓库目录已有一条流水线在运行（进程 ${holder.pid}，功能目录 ${holder.featureDir}，开始于 ${holder.startedAt}）。` +
        "同一个目录一次只能运行一条，请等它结束。",
    );
    this.name = "LockHeldError";
  }
}
