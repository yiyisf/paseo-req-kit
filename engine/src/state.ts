import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProfileName } from "./config.js";
import type { AgentUsage } from "./usage.js";
import type { StepId } from "./steps.js";

export type PipelineStatus = "running" | "waiting_for_business" | "failed" | "completed";

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

export function writeState(file: string, state: PipelineState): void {
  state.updatedAt = new Date().toISOString();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
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
