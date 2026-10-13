import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProfileName } from "./config.js";
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
}

export interface PipelineState {
  version: 1;
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

export function readState(file: string): PipelineState | null {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as PipelineState;
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
