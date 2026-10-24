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
//   req api models                         agents the daemon offers, the current and the recommended ones (1.12)
//   req api set-agents --json <设置>       writes builder, reviewer and fallback to the local config (1.12)
//   req api config [--repo <dir>] [--machine]  every setting, its value in words and which file set it (1.12)
//
// Reading never changes anything. `run` performs the same command as `req <command>` in that
// directory, so the engine stays the only one that changes a requirement's state.

import { progressOf, typical } from "./estimate.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resultText, stepName } from "./control.js";
import { FEATURES_DIR, findWorktreeRun, listFeatures, resolveFeatureArg, summarize } from "./features.js";
import { defaultConfigPath, KIT_ROOT, kitVersion } from "./locations.js";
import { configView } from "./config-view.js";
import { pruneIndex, readIndex, registerRequirement, requirementKey } from "./records.js";
import { listWorktreeRecords } from "./worktree.js";
import { readHumanReview } from "./code-review.js";
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

export type Attention = "approval" | "business" | "permission" | "interrupted" | "not_completed" | "not_started" | null;

/** What a person needs to do about a requirement, if anything. */
export function attentionOf(state: Pick<PipelineState, "status" | "pid" | "outcome" | "waitingPermission"> | null): Attention {
  if (!state) return null;
  if (state.status === "running" && state.waitingPermission && isAlive(state.pid)) return "permission";
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
  /** 1.13: the requirement has an interface prototype (the review page can show it). */
  hasPrototype?: boolean;
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
  /**
   * 1.12: for a requirement that needs a person (attention): since when, what it asks, why it
   * stopped, and the card it came from. Null otherwise.
   */
  waiting: {
    since: string;
    questions: string[];
    reason: string | null;
    card: { system: string; id: string; url: string | null; requester: string | null } | null;
    /** Whether a reply can be sent to the requirement's chat (req reply). */
    canReply: boolean;
    /** 1.13, attention "permission": the step agent that waits for an approval. */
    agentId?: string;
    /** 1.14, attention "not_started": the plugin can start development (req api run start). */
    canStart?: boolean;
  } | null;
}

/** 1.14: a confirmed spec with no run gets attention after this long (the chat may still be starting it). */
export const NOT_STARTED_AFTER_MS = 30 * 60_000;

function recordFor(repo: string, featureDir: string) {
  let real = repo;
  try {
    real = fs.realpathSync(repo);
  } catch {
    // As given.
  }
  return listWorktreeRecords().find((r) => r.repo === real && r.featureDir === featureDir) ?? null;
}

/** A confirmed requirement nobody started: its own worktree already made (a start that failed), or just confirmed. */
function notStartedOf(repo: string, featureDir: string, confirmed: boolean, updatedAt: string, now = Date.now()): NonNullable<ListItem["waiting"]> | null {
  if (!confirmed) return null;
  const real = (() => {
    try {
      return fs.realpathSync(repo);
    } catch {
      return repo;
    }
  })();
  const made = recordFor(real, featureDir);
  if (!made && now - new Date(updatedAt).getTime() < NOT_STARTED_AFTER_MS) return null;
  return {
    since: made?.createdAt ?? updatedAt,
    questions: [],
    reason: made ? "新工作区已经建好，但开发没有开始（上次启动没有完成）。点\"开始开发\"会在这个工作区里接着开始。" : "需求说明已经确认，但开发还没有开始。",
    card: null,
    canReply: false,
    canStart: true,
  };
}

function item(repo: string, branch: string | null, featureDir: string, extra: { sourceRepo: string | null; workspaceId: string | null; project: string }): ListItem | null {
  const name = path.basename(featureDir);
  const summary = summarize({ path: repo, branch }, name);
  if (!summary) return null;
  const state = readStateSafe(repo, featureDir);
  const notStarted = state || summary.developed ? null : notStartedOf(repo, summary.featureDir, summary.confirmed, summary.updatedAt);
  // 1.14: a worktree made for it before the pipeline ran: it still belongs to the chat's checkout.
  if (!state && !extra.sourceRepo) {
    const made = recordFor(repo, summary.featureDir);
    if (made) extra = { ...extra, sourceRepo: made.sourceRepo, workspaceId: extra.workspaceId ?? made.workspaceId, project: path.basename(made.sourceRepo) };
  }
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
    attention: attentionOf(state) ?? (notStarted ? "not_started" : null),
    current: currentSteps(state),
    updatedAt: summary.updatedAt,
    usage: usageOf(state),
    present: true,
    waiting: waitingOf(repo, featureDir, state) ?? notStarted,
    hasPrototype: fs.existsSync(path.join(repo, featureDir, "prototype")),
  };
}

function waitingOf(repo: string, featureDir: string, state: PipelineState | null): ListItem["waiting"] {
  if (!state || !attentionOf(state)) return null;
  let card: NonNullable<ListItem["waiting"]>["card"] = null;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(repo, featureDir, "source.json"), "utf8")) as { system?: string; id?: string; url?: string | null; author?: string | null };
    if (s.system && s.id) card = { system: s.system, id: s.id, url: s.url ?? null, requester: s.author ?? null };
  } catch {
    card = null;
  }
  const permission = attentionOf(state) === "permission" ? state.waitingPermission : null;
  return {
    since: permission?.since ?? state.updatedAt,
    questions: permission ? permission.requests : (state.pendingQuestions ?? []),
    reason: permission ? `「${permission.stepTitle}」步骤在等待权限批准，批准前会一直停在这里` : state.stopReason,
    ...(permission ? { agentId: permission.agentId } : {}),
    card,
    canReply: Boolean(state.originAgentId) && (state.status === "waiting_for_business" || state.status === "waiting_for_approval"),
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
  const index = readIndex();
  for (const e of index) {
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
        waiting: null,
      },
    );
  }
  // 1.14: requirements in projects this machine knows that were never registered (the chat did not
  // run --track, or an older version): found in the projects' feature directories.
  const seen = new Set(out.map((x) => x.key));
  const projects = new Set(index.filter((e) => e.present).map((e) => e.sourceRepo ?? e.repo));
  for (const dir of projects) {
    let found: ReturnType<typeof listFeatures> = [];
    try {
      found = listFeatures(dir);
    } catch {
      continue;
    }
    for (const f of found) {
      const state = readStateSafe(f.worktree, f.featureDir);
      const source = state?.worktree?.sourceRepo ?? (samePathSafe(f.worktree, dir) ? null : dir);
      const x = item(f.worktree, f.branch, f.featureDir, { sourceRepo: source, workspaceId: state?.worktree?.workspaceId ?? null, project: path.basename(dir) });
      if (x && !seen.has(x.key)) {
        seen.add(x.key);
        out.push(x);
      }
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function samePathSafe(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return a === b;
  }
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
    // 1.13: what to expect, from this machine's completed requirements of the same profile.
    estimate: estimateOf(state),
    // 1.14: the person's code review (plugin's code review page).
    humanReview: humanReviewOf(repo, featureDir),
    gate: state?.gate ?? null,
    external: Object.entries(state?.external ?? {}).map(([name, r]) => ({ name, id: r.id, url: r.url, status: r.status, syncedAt: r.syncedAt, pending: r.pending.length, lastError: r.pending.at(-1)?.error ?? null })),
    joint: (state?.joint ?? []).map((j) => ({ name: j.name, slug: j.slug, repo: j.repo, sourceRepo: j.sourceRepo, branch: j.branch, workspaceId: j.workspaceId, gate: j.gate ?? null })),
  };
}

function humanReviewOf(repo: string, featureDir: string) {
  const r = readHumanReview(path.join(repo, featureDir));
  if (!r) return null;
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", windowsHide: true }).stdout?.trim() || null;
  return { status: r.status, reviewer: r.reviewer, at: r.at, reviewers: r.reviewers, items: r.items.length, stale: r.status === "approved" && !!head && r.head !== head, consumedAttempt: r.consumedAttempt };
}

function estimateOf(state: PipelineState | null) {
  if (!state || state.status === "completed") return null;
  const t = typical(state.profile ?? "standard");
  if (!t) return null;
  const p = progressOf(state, t);
  return { basis: t.basis, profile: t.profile, typicalAgentMinutes: t.agentMinutes, typicalTokens: t.tokens, ...p };
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

const RUNNABLE = ["approve", "stop", "resume", "verify", "sync", "reply", "start"] as const;

/** Runs `req <command> <需求>` where people would, and reports what it said. */
/**
 * 1.14, starting from the plugin: like the chat would. In a project's main checkout the
 * requirement gets its own worktree (or continues in the one an earlier start made); the
 * pipeline reports to the chat the requirement was aligned in.
 */
export function startOptions(cwd: string, feature: string): string[] {
  const out: string[] = [];
  const git = (...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8", windowsHide: true });
  const dirs = git("rev-parse", "--git-dir", "--git-common-dir");
  if (dirs.status === 0) {
    const [own, common] = dirs.stdout.trim().split(/\r?\n/).map((d) => path.resolve(cwd, d.trim()));
    const branch = git("branch", "--show-current").stdout.trim();
    // In the main checkout, unless the requirement's own branch is checked out here ("develop here").
    if (own === common && branch !== `feature/${path.basename(feature)}`) out.push("--worktree");
  }
  let featureDir = feature;
  try {
    featureDir = resolveFeatureArg(cwd, feature);
  } catch {
    // The launcher reports it.
  }
  const chat = readIndex().find((e) => e.key === requirementKey(cwd, featureDir))?.chatAgentId;
  if (chat) out.push("--origin-agent", chat);
  return out;
}

export function apiRun(command: string, repoArg: string, feature: string, extra: string[]) {
  if (!(RUNNABLE as readonly string[]).includes(command)) throw new ApiError("not_allowed", `只能执行：${RUNNABLE.join("、")}`);
  if (!fs.existsSync(repoArg)) throw new ApiError("not_found", `目录不存在：${repoArg}`);
  const cwd = fs.realpathSync(repoArg);
  // Not from a chat: the run keeps reporting to the chat that started it.
  const env = { ...process.env };
  delete env.PASEO_AGENT_ID;
  delete env.PASEO_AGENT_CWD;
  if (command === "start") extra = [...extra, ...startOptions(cwd, feature)];
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

/** Runs the configuration program in one of its machine modes and returns its JSON line. */
function configureJson(args: string[]): Record<string, unknown> {
  const r = spawnSync(process.execPath, [path.join(KIT_ROOT, "bin", "req.mjs"), "configure", ...args], {
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
    env: process.env,
  });
  const line = (r.stdout ?? "").trim().split("\n").pop() ?? "";
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (!parsed) throw new ApiError("failed", `读取 agent 设置失败：${(r.stderr || r.error?.message || "没有输出").trim().split("\n").slice(-2).join(" ")}`);
  if (parsed.ok === false) throw new ApiError("failed", String(parsed.message ?? "失败"));
  return parsed;
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
    case "config": {
      // --machine: this machine's settings without any project's.
      const machineOnly = flag(argv, "--machine");
      return configView(defaultConfigPath(), machineOnly ? null : fs.realpathSync(repo));
    }
    case "models": {
      const { current, choices, recommended } = configureJson(["--catalog-json"]);
      return { current, choices, recommended };
    }
    case "set-agents": {
      const value = option(argv, "--json");
      if (!value) throw new ApiError("bad_arguments", "缺少 --json <设置>");
      const { message } = configureJson(["--set", value]);
      return { ok: true, message };
    }
    case "watchdog": {
      // 1.13: continue pipelines whose process died (the plugin runs this every few minutes).
      const by = (option(argv, "--by") ?? "manual") as "plugin" | "factory" | "manual";
      const dryRun = flag(argv, "--dry-run");
      return import("./watchdog.js").then(({ watchdogPass }) =>
        watchdogPass({ by: ["plugin", "factory"].includes(by) ? by : "manual", dryRun, resume: (r, f) => apiRun("resume", r, f, []) }),
      );
    }
    case "review-url": {
      // 1.13: the prototype review page of a requirement (starts the page's server when needed).
      const feature = need("需求");
      const readOnly = flag(argv, "--read-only");
      // 1.14 --page check: the acceptance checklist page of the same server.
      const pageArg = option(argv, "--page");
      const page = pageArg === "check" ? "check" : pageArg === "code" ? "code" : "prototype";
      const { repo: r, featureDir } = locate(repo, feature);
      return import("./review.js").then(async ({ ensureReviewServer, keyOf, reviewUrl }) => {
        const key = keyOf(r, featureDir);
        if (!key) throw new ApiError("not_found", `${featureDir} 不在本机的需求列表中`);
        if (page === "prototype" && !fs.existsSync(path.join(r, featureDir, "prototype"))) throw new ApiError("not_found", `${featureDir} 还没有界面原型`);
        if (page === "check" && !fs.existsSync(path.join(r, featureDir, "spec.md"))) throw new ApiError("not_found", `${featureDir} 中没有 spec.md`);
        if (page === "code" && !["implementation.md", "code-review.md"].some((f) => fs.existsSync(path.join(r, featureDir, f)))) throw new ApiError("not_found", `${featureDir} 还没有写代码，没有可以审查的改动`);
        const url = reviewUrl(await ensureReviewServer(), key, readOnly);
        return { url: page === "check" ? `${url}check/` : page === "code" ? `${url}code/` : url, readOnly };
      });
    }
    default:
      throw new ApiError("bad_arguments", `没有 "${command ?? ""}" 这个 api 命令。可用：version、list、status、file、stats、index、run、models、set-agents、config、review-url`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  let code = 0;
  let out: Record<string, unknown>;
  try {
    out = { schema: API_SCHEMA, kitVersion: kitVersion(), data: await apiMain(process.argv.slice(2)) };
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
