// Continuing pipelines whose background process died (1.13), without asking a model: a plain
// check of this machine's requirements that runs `req resume` for each one whose state says
// "running" but whose process is gone. The Paseo plugin runs it every few minutes inside the
// daemon (`req api watchdog`), and the card factory on each poll. Before 1.13 this was a Paseo
// schedule that woke the chat agent every hour to look — a model turn each time, and a recovery
// that depended on the model understanding the prompt.
import fs from "node:fs";
import path from "node:path";
import { kitHome } from "./locations.js";
import { readIndex } from "./records.js";
import { isAlive, readState, statePath, writeState } from "./state.js";

/** A run is left alone this long after its last write (it may be starting or finishing). */
const SETTLE_MS = 2 * 60_000;
/** At most this many automatic continuations per requirement per day. */
const MAX_PER_DAY = 3;
/** The plugin's watchdog counts as running when it checked within this time. */
export const HEARTBEAT_FRESH_MS = 15 * 60_000;

export const heartbeatFile = (env: NodeJS.ProcessEnv = process.env) => path.join(kitHome(env), "watchdog.json");

interface Memory {
  /** Last check, ISO time, and who ran it. */
  at?: string;
  by?: string;
  /** Per requirement: the dead process already handled, and when continuations happened. */
  handled?: Record<string, { pid: number; times: string[] }>;
}

function readMemory(env: NodeJS.ProcessEnv): Memory {
  try {
    return JSON.parse(fs.readFileSync(heartbeatFile(env), "utf8")) as Memory;
  } catch {
    return {};
  }
}

function writeMemory(env: NodeJS.ProcessEnv, m: Memory): void {
  try {
    fs.mkdirSync(path.dirname(heartbeatFile(env)), { recursive: true });
    const tmp = `${heartbeatFile(env)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
    fs.renameSync(tmp, heartbeatFile(env));
  } catch {
    // Best effort: the next check tries again.
  }
}

/** Whether the plugin's watchdog has checked recently (so the pipeline need not ask the chat to). */
export function watchdogActive(env: NodeJS.ProcessEnv = process.env, now = Date.now()): boolean {
  const m = readMemory(env);
  return m.by === "plugin" && !!m.at && now - new Date(m.at).getTime() < HEARTBEAT_FRESH_MS;
}

export interface WatchdogResult {
  checked: number;
  resumed: Array<{ featureDir: string; repo: string; message: string }>;
  failed: Array<{ featureDir: string; repo: string; message: string }>;
  skipped: Array<{ featureDir: string; reason: string }>;
}

export type Resume = (repo: string, featureDir: string) => { ok: boolean; message: string };

export function watchdogPass(input: { env?: NodeJS.ProcessEnv; by: "plugin" | "factory" | "manual"; resume: Resume; now?: Date; dryRun?: boolean }): WatchdogResult {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const memory = readMemory(env);
  const handled = memory.handled ?? {};
  const result: WatchdogResult = { checked: 0, resumed: [], failed: [], skipped: [] };
  for (const entry of readIndex(env)) {
    if (!entry.present) continue;
    const file = statePath(entry.repo, entry.featureDir);
    const state = readState(file);
    if (!state) continue;
    result.checked++;
    if (state.status !== "running" || isAlive(state.pid)) continue;
    if (now.getTime() - new Date(state.updatedAt).getTime() < SETTLE_MS) continue;
    const h = handled[entry.key];
    if (h?.pid === state.pid) continue;
    const recent = (h?.times ?? []).filter((t) => now.getTime() - new Date(t).getTime() < 24 * 3600_000);
    if (recent.length >= MAX_PER_DAY) {
      result.skipped.push({ featureDir: entry.featureDir, reason: `24 小时内已自动继续 ${recent.length} 次，不再自动继续，请人看一下日志` });
      handled[entry.key] = { pid: state.pid, times: recent };
      continue;
    }
    if (input.dryRun) {
      result.resumed.push({ featureDir: entry.featureDir, repo: entry.repo, message: "（试运行，没有继续）" });
      continue;
    }
    // Say why in the state first: the continued run reads it, and statistics count it.
    state.stopKind = "process_exit";
    state.stopReason = "后台进程意外退出";
    state.recoveries = [...(state.recoveries ?? []), { at: now.toISOString(), key: "pipeline", kind: "auto_resume", detail: `后台进程 ${state.pid} 意外退出，${input.by === "plugin" ? "插件" : input.by === "factory" ? "接单器" : "检查"}自动继续` }];
    try {
      writeState(file, state);
    } catch {
      /* the resume still runs */
    }
    const r = input.resume(entry.sourceRepo ?? entry.repo, entry.featureDir);
    handled[entry.key] = { pid: state.pid, times: [...recent, now.toISOString()] };
    (r.ok ? result.resumed : result.failed).push({ featureDir: entry.featureDir, repo: entry.repo, message: r.message.split("\n").find((l) => l.trim()) ?? "" });
  }
  writeMemory(env, { at: now.toISOString(), by: input.by === "manual" ? (memory.by ?? "manual") : input.by, handled });
  return result;
}
