// Machine records under the kit home (1.9, ADR 0026): what this machine knows beyond one
// repository. Neither is committed anywhere; both are local to the machine.
//
//   index/<key>.json      one file per requirement that has run here: where it lives, so
//                         `req api list --all` and the Paseo plugin can find every requirement
//                         on the machine. The overview itself is still read live (ADR 0010).
//   usage/runs.jsonl      one line per pipeline run (a process from start to stop): steps,
//                         time, usage, gate and review rounds. What `req stats` reports on.
//                         1.14: also one line per event after the run: a person's code review,
//                         the acceptance, the merge into the main line, a problem found after it.
//
// Recording never affects a run: every write is best effort. REQ_KIT_NO_RECORD=1 turns both
// off (evaluation runs are not real requirements).

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { kitHome, kitVersion } from "./locations.js";
import type { PipelineState } from "./state.js";

export const RECORD_SCHEMA = 1;

function recordingOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REQ_KIT_NO_RECORD === "1" || env.REQ_KIT_NO_RECORD === "true";
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// ---------------------------------------------------------------------------
// Index

export interface IndexEntry {
  schema: 1;
  /** Stable key of the requirement on this machine (also the file name). */
  key: string;
  /** Where the requirement is developed (its own worktree when it has one). */
  repo: string;
  featureDir: string;
  /** The checkout the chat works in, when the requirement has its own worktree. */
  sourceRepo: string | null;
  workspaceId: string | null;
  /** Name of the project: the source checkout's directory name. */
  project: string;
  registeredAt: string;
  /** 1.14: the chat the requirement is being aligned in (registered before the pipeline ran). */
  chatAgentId?: string | null;
}

export function indexDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(kitHome(env), "index");
}

/** Key of a requirement: the checkout people work in plus the feature directory. */
export function requirementKey(sourceOrRepo: string, featureDir: string): string {
  return createHash("sha1").update(`${real(sourceOrRepo)}\0${featureDir.split(path.sep).join("/")}`).digest("hex").slice(0, 16);
}

/** Records where this requirement lives, if it is not recorded that way already. Never throws. */
export function registerRequirement(state: Pick<PipelineState, "repo" | "featureDir" | "worktree">, env: NodeJS.ProcessEnv = process.env, chatAgentId: string | null = null): void {
  if (recordingOff(env)) return;
  try {
    const source = state.worktree?.sourceRepo ?? null;
    const key = requirementKey(source ?? state.repo, state.featureDir);
    const file = path.join(indexDir(env), `${key}.json`);
    const existing = readEntry(file);
    const entry: IndexEntry = {
      schema: 1,
      key,
      repo: real(state.repo),
      featureDir: state.featureDir.split(path.sep).join("/"),
      sourceRepo: source ? real(source) : null,
      workspaceId: state.worktree?.workspaceId ?? null,
      project: path.basename(real(source ?? state.repo)),
      registeredAt: existing?.registeredAt ?? new Date().toISOString(),
      ...(chatAgentId ?? existing?.chatAgentId ? { chatAgentId: chatAgentId ?? existing?.chatAgentId ?? null } : {}),
    };
    if (existing && JSON.stringify(existing) === JSON.stringify(entry)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch {
    // The index is a convenience; the run goes on without it.
  }
}

/**
 * 1.14: a requirement whose interview has started: marked in its feature directory
 * (.pipeline/tracked.json, not committed) and registered with its chat, so the plugin lists it
 * before the pipeline ever runs.
 */
export function trackRequirement(repo: string, featureDir: string, chatAgentId: string | null, env: NodeJS.ProcessEnv = process.env): void {
  const marker = path.join(repo, featureDir, ".pipeline", "tracked.json");
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  let since = new Date().toISOString();
  try {
    since = (JSON.parse(fs.readFileSync(marker, "utf8")) as { since?: string }).since ?? since;
  } catch {
    // First time.
  }
  fs.writeFileSync(marker, `${JSON.stringify({ since, chatAgentId }, null, 2)}\n`);
  registerRequirement({ repo, featureDir, worktree: null }, env, chatAgentId);
}

function readEntry(file: string): IndexEntry | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as IndexEntry;
    return raw && typeof raw.repo === "string" && typeof raw.featureDir === "string" ? raw : null;
  } catch {
    return null;
  }
}

/** Every recorded requirement, with whether its directory is still there. */
export function readIndex(env: NodeJS.ProcessEnv = process.env): Array<IndexEntry & { present: boolean }> {
  const dir = indexDir(env);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => readEntry(path.join(dir, n)))
    .filter((e): e is IndexEntry => e !== null)
    // 1.14: a requirement still in its interview has no state yet, only its notes.
    .map((e) => ({ ...e, present: ["spec.md", "alignment.md", ".pipeline/state.json", ".pipeline/tracked.json"].some((f) => fs.existsSync(path.join(e.repo, e.featureDir, f))) }));
}

/** Removes the entries whose requirement is gone. Returns how many. */
export function pruneIndex(env: NodeJS.ProcessEnv = process.env): number {
  let removed = 0;
  for (const e of readIndex(env)) {
    if (e.present) continue;
    fs.rmSync(path.join(indexDir(env), `${e.key}.json`), { force: true });
    removed++;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Usage records

export interface StepUsageRecord {
  key: string;
  stepId: string;
  phase: string | null;
  attempt: number;
  round: number | null;
  startedAt: string;
  endedAt: string | null;
  minutes: number;
  outcome: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** 1.13: input tokens served from the prompt cache (part of inputTokens), when the agent reports them. */
  cachedInputTokens?: number | null;
  /** 1.13: the agent the step ran with (Paseo profile name or "provider/model"). */
  agent?: string | null;
}

/** One pipeline run: a process from its start to its end (contracts/usage-record.md). */
export interface RunRecord {
  schema: 1;
  kind: "run";
  machine: string;
  kitVersion: string;
  requirement: {
    key: string;
    project: string;
    name: string;
    title: string;
    type: string | null;
    profile: string;
    /** Who asked for it: the card's author for a requirement that started from a card (1.10). */
    requester?: string | null;
    /** The card it started from, e.g. { system: "ALM", id: "…" } (1.10). */
    source?: { system: string; id: string } | null;
  };
  run: {
    startedAt: string;
    endedAt: string;
    attempt: number;
    phase: string | null;
    phaseMode: string | null;
    /** State at the end of the run: completed, phase_done, waiting_for_approval, failed… */
    status: string;
    /** The report's verdict when the run completed (completed, completed_with_issues, not_completed). */
    outcome: string | null;
    stopReason: string | null;
    /** 1.12: why the run stopped for a person, as a code (absent in older records). */
    stopKind?: string | null;
    /** 1.12: what the pipeline handled by itself during the run, by kind (absent in older records). */
    recoveries?: Record<string, number>;
  };
  agents: { builder: string | null; reviewer: string | null };
  steps: StepUsageRecord[];
  gate: { runs: number; failed: number };
}

export function usageDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(kitHome(env), "usage");
}

export function runsFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(usageDir(env), "runs.jsonl");
}

function minutesBetween(from: string, to: string | null, now: Date): number {
  const end = to ? new Date(to) : now;
  return Math.max(0, Math.round(((end.getTime() - new Date(from).getTime()) / 60_000) * 10) / 10);
}

/** The record of the run that started at `runStartedAt`, from the state at its end. */
export function runRecord(input: {
  state: PipelineState;
  runStartedAt: string;
  title: string;
  agents: { builder: string | null; reviewer: string | null };
  now?: Date;
  machine?: string;
}): RunRecord {
  const { state } = input;
  const now = input.now ?? new Date();
  const source = state.worktree?.sourceRepo ?? state.repo;
  const since = new Date(input.runStartedAt).getTime();
  const steps = state.history
    .filter((h) => new Date(h.startedAt).getTime() >= since)
    .map(
      (h): StepUsageRecord => ({
        key: h.key,
        stepId: h.stepId,
        phase: h.phase ?? null,
        attempt: h.attempt,
        round: h.round,
        startedAt: h.startedAt,
        endedAt: h.endedAt,
        minutes: minutesBetween(h.startedAt, h.endedAt, now),
        outcome: h.outcome,
        inputTokens: h.usage?.inputTokens ?? null,
        outputTokens: h.usage?.outputTokens ?? null,
        costUsd: h.usage?.totalCostUsd ?? null,
        cachedInputTokens: h.usage?.cachedInputTokens ?? null,
        agent: h.agent ?? null,
      }),
    );
  const gateRuns = [...(state.gate?.runs ?? []), ...(state.joint ?? []).flatMap((j) => j.gate?.runs ?? [])].filter(
    (r) => new Date(r.at).getTime() >= since,
  );
  return {
    schema: 1,
    kind: "run",
    machine: input.machine ?? os.hostname(),
    kitVersion: kitVersion(),
    requirement: {
      key: requirementKey(source, state.featureDir),
      project: path.basename(real(source)),
      name: path.basename(state.featureDir),
      title: input.title,
      type: state.type ?? null,
      profile: state.profile,
      ...cardOrigin(state.repo, state.featureDir),
    },
    run: {
      startedAt: input.runStartedAt,
      endedAt: now.toISOString(),
      attempt: state.attempt,
      phase: state.phase ?? null,
      phaseMode: state.phases?.mode ?? null,
      status: state.status,
      outcome: state.status === "completed" ? state.outcome : null,
      stopReason: state.stopReason,
      stopKind: state.status === "completed" || state.status === "running" ? null : (state.stopKind ?? null),
      recoveries: (state.recoveries ?? [])
        .filter((r) => new Date(r.at).getTime() >= since)
        .reduce<Record<string, number>>((m, r) => ({ ...m, [r.kind]: (m[r.kind] ?? 0) + 1 }), {}),
    },
    agents: input.agents,
    steps,
    gate: { runs: gateRuns.length, failed: gateRuns.filter((r) => !r.passed).length },
  };
}

/** The card a requirement started from (source.json), for the record. */
function cardOrigin(repo: string, featureDir: string): { requester: string | null; source: { system: string; id: string } } | Record<string, never> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(repo, featureDir, "source.json"), "utf8")) as { system?: unknown; id?: unknown; author?: unknown };
    if (typeof raw.system !== "string" || typeof raw.id !== "string") return {};
    return { requester: typeof raw.author === "string" ? raw.author : null, source: { system: raw.system, id: raw.id } };
  } catch {
    return {};
  }
}

/** Appends a run record. Never throws. */
export function appendRun(record: RunRecord, env: NodeJS.ProcessEnv = process.env): void {
  if (recordingOff(env)) return;
  try {
    fs.mkdirSync(usageDir(env), { recursive: true });
    fs.appendFileSync(runsFile(env), `${JSON.stringify(record)}\n`);
  } catch {
    // Usage records are a convenience; the run is not affected.
  }
}

/** Run records from a JSONL file (this machine's, or an export from another). Bad lines are skipped. */
export function readRuns(file: string): RunRecord[] {
  if (!fs.existsSync(file)) return [];
  const out: RunRecord[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as RunRecord;
      if (r && r.kind === "run" && r.schema === RECORD_SCHEMA && r.requirement && r.run) out.push(r);
    } catch {
      // A torn last line (power loss mid-write) or a foreign line.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Events after the run (1.14)

export type EventKind = "review" | "acceptance" | "merge" | "issue";

/** Something that happened to a requirement outside its runs (contracts/usage-record.md). */
export interface EventRecord {
  schema: 1;
  kind: EventKind;
  machine: string;
  kitVersion: string;
  at: string;
  requirement: { key: string; project: string; name: string; title: string };
  /** A person's code review in the plugin. */
  review?: { verdict: "approved" | "changes_requested"; reviewer: string; items: number; head: string | null };
  /** The requester's acceptance on the checklist page. */
  acceptance?: { verdict: "通过" | "不通过"; reviewer: string; total: number; passed: number; failed: number; unchecked: number };
  /** The requirement's change reached the main line. how: found its files there ("files"), or a person said so ("manual"). */
  merge?: { into: string; commit: string | null; mergedAt: string | null; how: "files" | "manual" };
  /** A problem found after the merge: from a defect requirement that names this one, or a person's note. */
  issue?: { text: string; by: string | null; id: string };
}

/** The requirement as events name it: the index entry when there is one (same key as its runs). */
export function requirementRef(repo: string, featureDir: string, env: NodeJS.ProcessEnv = process.env): EventRecord["requirement"] {
  const fd = featureDir.split(path.sep).join("/");
  const r = real(repo);
  const entry = readIndex(env).find((e) => e.featureDir === fd && (real(e.repo) === r || (e.sourceRepo && real(e.sourceRepo) === r)));
  const source = entry?.sourceRepo ?? entry?.repo ?? repo;
  let title = path.basename(fd);
  try {
    const m = /^#\s+(.+)$/m.exec(fs.readFileSync(path.join(entry?.repo ?? repo, fd, "spec.md"), "utf8"));
    if (m) title = m[1].trim();
  } catch {
    /* no spec: the directory name */
  }
  return { key: entry?.key ?? requirementKey(source, fd), project: entry?.project ?? path.basename(real(source)), name: path.basename(fd), title };
}

/** Appends an event to the usage records. Never throws. */
export function appendEvent(input: Omit<EventRecord, "schema" | "machine" | "kitVersion" | "at"> & { at?: string }, env: NodeJS.ProcessEnv = process.env): void {
  if (recordingOff(env)) return;
  const record: EventRecord = { schema: 1, machine: os.hostname(), kitVersion: kitVersion(), at: input.at ?? new Date().toISOString(), ...input } as EventRecord;
  try {
    fs.mkdirSync(usageDir(env), { recursive: true });
    fs.appendFileSync(runsFile(env), `${JSON.stringify(record)}\n`);
  } catch {
    // Usage records are a convenience.
  }
}

const EVENT_KINDS = new Set<string>(["review", "acceptance", "merge", "issue"]);

/** Event records from a JSONL file (this machine's, or an export). */
export function readEvents(file: string): EventRecord[] {
  if (!fs.existsSync(file)) return [];
  const out: EventRecord[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as EventRecord;
      if (r && EVENT_KINDS.has(r.kind) && r.schema === RECORD_SCHEMA && r.requirement && typeof r.at === "string") out.push(r);
    } catch {
      // A torn line.
    }
  }
  return out;
}
