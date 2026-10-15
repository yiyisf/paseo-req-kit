// `req api`: machine-readable output for programs (the Paseo plugin, scripts), 1.9.
// The format is a contract (contracts/cli-json.md): every command prints one JSON object,
//   { "schema": 1, "kitVersion": "…", "data": … }        exit 0
//   { "schema": 1, "kitVersion": "…", "error": { "code", "message" } }   exit 1
//
//   req api version
//   req api list [--all] [--repo <dir>]
//   req api status <需求> [--repo <dir>]
//   req api file <需求> <文件> [--repo <dir>]
//   req api stats [--since 30d] [--month 2026-10]
//   req api index [--rebuild <dir>...] [--prune]
//   req api run <approve|stop|resume|verify> <需求> [--repo <dir>] [其他选项]
//
// Reading never changes anything. `run` performs the same command as `req <command>` in that
// directory, so the engine stays the only one that changes a requirement's state.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resultText, stepName } from "./control.js";
import { FEATURES_DIR, findWorktreeRun, listFeatures, resolveFeatureArg, summarize } from "./features.js";
import { KIT_ROOT, kitVersion } from "./locations.js";
import { pruneIndex, readIndex, registerRequirement, requirementKey } from "./records.js";
import { isAlive, type PipelineState, readState, statePath, type StepRecord } from "./state.js";
import { parsePeriod, summarizeRuns } from "./stats.js";
import { readRuns, runsFile } from "./records.js";
import { totals } from "./usage.js";

export const API_SCHEMA = 1;

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Documents a program may read from a feature directory (`req api file`). */
export const READABLE_FILES = [
  "spec.md",
  "alignment.md",
  "spec-review.md",
  "changes.md",
  "decisions.tsv",
  "design.md",
  "design-review.md",
  "preview.md",
  "contract.md",
  "diagnosis.md",
  "assessment.md",
  "implementation.md",
  "progress.md",
  "code-review.md",
  "handoff.md",
  "service-start.md",
  "verification.md",
  "report.md",
  "acceptance.md",
  "lessons.tsv",
] as const;

const MAX_FILE_BYTES = 512 * 1024;

export type Attention = "approval" | "business" | "interrupted" | "not_completed" | null;

/** What a person needs to do about a requirement, if anything. */
export function attentionOf(state: Pick<PipelineState, "status" | "pid" | "outcome"> | null): Attention {
  if (!state) return null;
  if (state.status === "waiting_for_approval") return "approval";
  if (state.status === "waiting_for_business") return "business";
  if (state.status === "failed" || (state.status === "running" && !isAlive(state.pid))) return "interrupted";
  if (state.status === "completed" && state.outcome === "not_completed") return "not_completed";
  return null;
}

function usageOf(state: PipelineState | null) {
  if (!state || state.history.length === 0) return null;
  const t = totals(state.history);
  return { steps: t.steps, agentMinutes: Math.round(t.agentMinutes * 10) / 10, inputTokens: t.inputTokens, outputTokens: t.outputTokens, costUsd: t.costUsd };
}

function readStateSafe(repo: string, featureDir: string): PipelineState | null {
  try {
    return readState(statePath(repo, featureDir));
  } catch {
    return null;
  }
}

function currentSteps(state: PipelineState | null) {
  if (!state || state.status !== "running" || !isAlive(state.pid)) return [];
  return state.history.filter((h) => h.outcome === "running").map((h) => ({ key: h.key, title: stepName(h, state), agentId: h.agentId }));
}

export interface ListItem {
  key: string;
  project: string;
  repo: string;
  sourceRepo: string | null;
  workspaceId: string | null;
  featureDir: string;
  name: string;
  title: string;
  type: string | null;
  profile: string | null;
  branch: string | null;
  /** Plain-language stage, as `req list` shows it. */
  stage: string;
  /** The state file's status; null before the first run. */
  status: string | null;
  running: boolean;
  phase: string | null;
  attention: Attention;
  current: Array<{ key: string; title: string; agentId: string }>;
  updatedAt: string;
  usage: ReturnType<typeof usageOf>;
  /** False when the index still lists a requirement whose directory is gone. */
  present: boolean;
}

function item(repo: string, branch: string | null, featureDir: string, extra: { sourceRepo: string | null; workspaceId: string | null; project: string }): ListItem | null {
  const name = path.basename(featureDir);
  const summary = summarize({ path: repo, branch }, name);
  if (!summary) return null;
  const state = readStateSafe(repo, featureDir);
  return {
    key: requirementKey(extra.sourceRepo ?? repo, featureDir),
    project: extra.project,
    repo,
    sourceRepo: extra.sourceRepo,
    workspaceId: extra.workspaceId ?? state?.worktree?.workspaceId ?? null,
    featureDir: summary.featureDir,
    name,
    title: summary.title,
    type: state?.type ?? null,
    profile: summary.profile ?? state?.profile ?? null,
    branch: state?.branch ?? summary.branch,
    stage: summary.stage,
    status: state?.status ?? null,
    running: !!state && state.status === "running" && isAlive(state.pid),
    phase: state?.phase ?? null,
    attention: attentionOf(state),
    current: currentSteps(state),
    updatedAt: summary.updatedAt,
    usage: usageOf(state),
    present: true,
  };
}

/** Requirements of the repository at `repo` (all its worktrees), or of the whole machine. */
export function apiList(input: { repo: string; all: boolean }): ListItem[] {
  if (!input.all) {
    const repo = fs.realpathSync(input.repo);
    return listFeatures(repo)
      .map((f) => {
        const state = readStateSafe(f.worktree, f.featureDir);
        const source = state?.worktree?.sourceRepo ?? null;
        return item(f.worktree, f.branch, f.featureDir, { sourceRepo: source, workspaceId: state?.worktree?.workspaceId ?? null, project: path.basename(source ?? repo) });
      })
      .filter((x): x is ListItem => x !== null);
  }
  const out: ListItem[] = [];
  for (const e of readIndex()) {
    const found = e.present ? item(e.repo, null, e.featureDir, { sourceRepo: e.sourceRepo, workspaceId: e.workspaceId, project: e.project }) : null;
    out.push(
      found ?? {
        key: e.key,
        project: e.project,
        repo: e.repo,
        sourceRepo: e.sourceRepo,
        workspaceId: e.workspaceId,
        featureDir: e.featureDir,
        name: path.basename(e.featureDir),
        title: path.basename(e.featureDir),
        type: null,
        profile: null,
        branch: null,
        stage: "已移除（目录不在了）",
        status: null,
        running: false,
        phase: null,
        attention: null,
        current: [],
        updatedAt: e.registeredAt,
        usage: null,
        present: false,
      },
    );
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The repository and feature directory a requirement argument names, as `req status` resolves it. */
export function locate(repoArg: string, feature: string): { repo: string; featureDir: string; sourceRepo: string | null } {
  if (!fs.existsSync(repoArg)) throw new ApiError("not_found", `目录不存在：${repoArg}`);
  const repo = fs.realpathSync(repoArg);
  let here: string | null = null;
  try {
    here = resolveFeatureArg(repo, feature);
  } catch {
    here = null;
  }
  if (here && fs.existsSync(statePath(repo, here))) return { repo, featureDir: here, sourceRepo: null };
  const away = findWorktreeRun(repo, here ?? feature);
  if (away) return { repo: away.repo, featureDir: away.featureDir, sourceRepo: repo };
  if (here) return { repo, featureDir: here, sourceRepo: null };
  throw new ApiError("not_found", `没有找到需求"${feature}"（${repo}）`);
}

function stepJson(h: StepRecord, state: PipelineState) {
  const minutes = Math.max(0, ((h.endedAt ? new Date(h.endedAt) : new Date()).getTime() - new Date(h.startedAt).getTime()) / 60_000);
  return {
    key: h.key,
    stepId: h.stepId,
    title: stepName(h, state),
    phase: h.phase ?? null,
    attempt: h.attempt,
    round: h.round,
    agentId: h.agentId,
    startedAt: h.startedAt,
    endedAt: h.endedAt,
    minutes: Math.round(minutes * 10) / 10,
    outcome: h.outcome,
    result: h.outcome === "completed" ? resultText(h) : null,
    error: h.error,
    usage: h.usage ?? null,
  };
}

export function apiStatus(repoArg: string, feature: string) {
  const { repo, featureDir, sourceRepo } = locate(repoArg, feature);
  const state = readStateSafe(repo, featureDir);
  const source = sourceRepo ?? state?.worktree?.sourceRepo ?? null;
  const base = item(repo, state?.branch ?? null, featureDir, { sourceRepo: source, workspaceId: state?.worktree?.workspaceId ?? null, project: path.basename(source ?? repo) });
  if (!base) throw new ApiError("not_found", `${featureDir} 中没有 spec.md`);
  const dir = path.join(repo, featureDir);
  return {
    ...base,
    files: READABLE_FILES.filter((f) => fs.existsSync(path.join(dir, f))),
    run: state
      ? {
          attempt: state.attempt,
          startedAt: state.startedAt,
          updatedAt: state.updatedAt,
          pid: state.pid,
          phaseMode: state.phases?.mode ?? null,
          stopReason: state.stopReason,
          outcome: state.outcome,
          queuedSince: state.queuedSince ?? null,
          verifyAt: state.verifyAt ?? null,
          approval: state.approval ?? null,
          originAgentId: state.originAgentId,
        }
      : null,
    steps: state ? state.history.map((h) => stepJson(h, state)) : [],
    gate: state?.gate ?? null,
    joint: (state?.joint ?? []).map((j) => ({ name: j.name, slug: j.slug, repo: j.repo, sourceRepo: j.sourceRepo, branch: j.branch, workspaceId: j.workspaceId, gate: j.gate ?? null })),
  };
}

export function apiFile(repoArg: string, feature: string, file: string) {
  if (!(READABLE_FILES as readonly string[]).includes(file)) {
    throw new ApiError("not_allowed", `只能读取这些文件：${READABLE_FILES.join("、")}`);
  }
  const { repo, featureDir } = locate(repoArg, feature);
  const full = path.join(repo, featureDir, file);
  if (!fs.existsSync(full)) throw new ApiError("not_found", `${featureDir} 中没有 ${file}`);
  const size = fs.statSync(full).size;
  const buf = fs.readFileSync(full);
  return { featureDir, file, size, truncated: size > MAX_FILE_BYTES, content: buf.subarray(0, MAX_FILE_BYTES).toString("utf8") };
}

/** Registers the requirements that have run in these directories' repositories (all worktrees). */
export function apiIndex(input: { rebuild: string[]; prune: boolean }) {
  let registered = 0;
  const dirs = new Set(input.rebuild.map((d) => path.resolve(d)));
  for (const e of readIndex()) if (input.rebuild.length > 0 && e.present) dirs.add(e.sourceRepo ?? e.repo);
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of listFeatures(dir)) {
      const state = readStateSafe(f.worktree, f.featureDir);
      if (!state) continue;
      registerRequirement({ repo: f.worktree, featureDir: f.featureDir, worktree: state.worktree ?? null });
      registered++;
    }
  }
  const pruned = input.prune ? pruneIndex() : 0;
  return { scanned: [...dirs], registered, pruned, total: readIndex().length };
}

const RUNNABLE = ["approve", "stop", "resume", "verify"] as const;

/** Runs `req <command> <需求>` where people would, and reports what it said. */
export function apiRun(command: string, repoArg: string, feature: string, extra: string[]) {
  if (!(RUNNABLE as readonly string[]).includes(command)) throw new ApiError("not_allowed", `只能执行：${RUNNABLE.join("、")}`);
  if (!fs.existsSync(repoArg)) throw new ApiError("not_found", `目录不存在：${repoArg}`);
  const cwd = fs.realpathSync(repoArg);
  // Not from a chat: the run keeps reporting to the chat that started it.
  const env = { ...process.env };
  delete env.PASEO_AGENT_ID;
  delete env.PASEO_AGENT_CWD;
  const r = spawnSync(process.execPath, [path.join(KIT_ROOT, "bin", "req.mjs"), command, feature, ...extra], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { command, featureDir: feature, ok: r.status === 0, exitCode: r.status, message: r.error ? r.error.message : output };
}

// ---------------------------------------------------------------------------
// CLI

function option(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new ApiError("bad_arguments", `${name} 后面要写值`);
  argv.splice(i, 2);
  return v;
}

function flag(argv: string[], name: string): boolean {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
}

export function apiMain(argvIn: string[], cwd = process.cwd()): unknown {
  const argv = [...argvIn];
  const command = argv.shift();
  const repo = option(argv, "--repo") ?? cwd;
  const need = (what: string) => {
    const v = argv.shift();
    if (!v || v.startsWith("--")) throw new ApiError("bad_arguments", `缺少${what}`);
    return v;
  };
  switch (command) {
    case "version":
      return {
        kitVersion: kitVersion(),
        kitRoot: KIT_ROOT,
        apiSchema: API_SCHEMA,
        paseo: (JSON.parse(fs.readFileSync(path.join(KIT_ROOT, "package.json"), "utf8")) as { reqKit?: { paseo?: string } }).reqKit?.paseo ?? null,
        featuresDir: FEATURES_DIR.split(path.sep).join("/"),
      };
    case "list":
      return apiList({ repo, all: flag(argv, "--all") });
    case "status":
      return apiStatus(repo, need("需求"));
    case "file": {
      const feature = need("需求");
      return apiFile(repo, feature, need("文件名"));
    }
    case "stats": {
      const since = option(argv, "--since");
      const month = option(argv, "--month");
      return summarizeRuns(readRuns(runsFile()), parsePeriod({ since, month }));
    }
    case "index": {
      const prune = flag(argv, "--prune");
      const rebuild: string[] = [];
      if (flag(argv, "--rebuild")) {
        while (argv[0] && !argv[0].startsWith("--")) rebuild.push(argv.shift()!);
        if (rebuild.length === 0) rebuild.push(cwd);
      }
      return rebuild.length > 0 || prune ? apiIndex({ rebuild, prune }) : readIndex();
    }
    case "run": {
      const what = need("命令（approve、stop、resume、verify）");
      return apiRun(what, repo, need("需求"), argv.splice(0));
    }
    default:
      throw new ApiError("bad_arguments", `没有 "${command ?? ""}" 这个 api 命令。可用：version、list、status、file、stats、index、run`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  let code = 0;
  let out: Record<string, unknown>;
  try {
    out = { schema: API_SCHEMA, kitVersion: kitVersion(), data: apiMain(process.argv.slice(2)) };
    const data = out.data as { ok?: boolean } | null;
    if (data && data.ok === false) code = 1;
  } catch (error) {
    const e = error as Error & { code?: string };
    out = { schema: API_SCHEMA, kitVersion: kitVersion(), error: { code: error instanceof ApiError ? e.code : "failed", message: e.message } };
    code = 1;
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(code);
}
