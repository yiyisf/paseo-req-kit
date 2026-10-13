// Overview of every requirement in a repository, across all of its worktrees.
//
// Each requirement normally lives on its own worktree and branch, so a committed
// index file would conflict on every merge. The overview is generated instead:
// `start-pipeline --list` prints it, and /req uses it for status and takeover.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PROFILE_LABELS, type ProfileName } from "./config.js";
import { samePath } from "./paths.js";
import { isSpecConfirmed, specProfile } from "./preflight.js";
import { isAlive } from "./state.js";
import { describeTotals, totals } from "./usage.js";

export const FEATURES_DIR = path.join("docs", "features");

export interface FeatureSummary {
  /** Directory name, e.g. 20261012-sms-login. */
  name: string;
  /** Relative to the worktree root, "/"-separated. */
  featureDir: string;
  worktree: string;
  branch: string | null;
  title: string;
  type: string | null;
  specVersion: number | null;
  confirmed: boolean;
  profile: ProfileName | null;
  /** Plain-language stage, e.g. "对齐中", "开发中", "待验收", "已验收". */
  stage: string;
  /** Last change to the feature directory's state or spec, ISO time. */
  updatedAt: string;
  /** Time and usage of all pipeline attempts, in words; null before the first run. */
  usage: string | null;
}

interface Worktree {
  path: string;
  branch: string | null;
}

/** Worktrees of the repository containing `repo`, or just `repo` outside git. */
export function worktrees(repo: string): Worktree[] {
  let out: string;
  try {
    out = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return [{ path: repo, branch: null }];
  }
  const list: Worktree[] = [];
  let current: Worktree | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      // git prints forward slashes on Windows too; normalize for display and comparison.
      current = { path: path.resolve(line.slice("worktree ".length).trim()), branch: null };
      list.push(current);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  return list.filter((w) => fs.existsSync(w.path));
}

function headerValue(spec: string, key: string): string | null {
  const match = new RegExp(`^\\s*-\\s*${key}\\s*[:：]\\s*(.+)$`, "m").exec(spec);
  return match ? match[1].trim() : null;
}

interface RawState {
  status?: string;
  pid?: number;
  outcome?: string | null;
  updatedAt?: string;
  phases?: { mode?: string } | null;
  phase?: string;
  history?: Array<{ attempt: number; startedAt: string; endedAt: string | null; usage?: Record<string, number> | null }>;
}

function stageOf(confirmed: boolean, state: RawState | null, acceptance: string | null): string {
  if (acceptance) {
    const verdict = headerValue(acceptance, "验收结论");
    if (verdict?.startsWith("通过")) return "已验收";
    if (verdict?.startsWith("不通过")) return "验收未通过";
  }
  if (!state) return confirmed ? "已确认，未开始开发" : "对齐中";
  switch (state.status) {
    case "running":
      return state.pid && isAlive(state.pid) ? "开发中" : "已中断（可继续）";
    case "waiting_for_business":
      return "等待需求方决定";
    case "phase_done":
      return "研发完成，待测试验证";
    case "failed":
      return "已中断（可继续）";
    case "completed":
      if (state.outcome === "not_completed") return "开发结束，未完成";
      return state.phases?.mode === "develop-only" && state.phase !== "verify" ? "待验收（研发完成，需人工测试）" : "待验收";
    default:
      return state.status ?? "未知";
  }
}

function mtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export function summarize(worktree: Worktree, name: string): FeatureSummary | null {
  const dir = path.join(worktree.path, FEATURES_DIR, name);
  const specFile = path.join(dir, "spec.md");
  if (!fs.existsSync(specFile)) return null;
  const spec = fs.readFileSync(specFile, "utf8");
  const stateFile = path.join(dir, ".pipeline", "state.json");
  let state: RawState | null = null;
  try {
    if (fs.existsSync(stateFile)) state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as RawState;
  } catch {
    state = { status: "unreadable" };
  }
  const acceptanceFile = path.join(dir, "acceptance.md");
  const acceptance = fs.existsSync(acceptanceFile) ? fs.readFileSync(acceptanceFile, "utf8") : null;
  const confirmed = isSpecConfirmed(spec);
  const version = Number(headerValue(spec, "版本"));
  const updated = Math.max(mtime(specFile), mtime(stateFile), mtime(acceptanceFile), mtime(path.join(dir, "changes.md")));
  return {
    name,
    featureDir: `${FEATURES_DIR.split(path.sep).join("/")}/${name}`,
    worktree: worktree.path,
    branch: worktree.branch,
    title: (/^#\s+(.+)$/m.exec(spec)?.[1] ?? name).trim(),
    type: headerValue(spec, "类型"),
    specVersion: Number.isInteger(version) && version > 0 ? version : null,
    confirmed,
    profile: specProfile(spec),
    stage: stageOf(confirmed, state, acceptance),
    updatedAt: new Date(updated || Date.now()).toISOString(),
    usage: state?.history && state.history.length > 0 ? describeTotals(totals(state.history)) : null,
  };
}

/**
 * Every requirement visible from `repo`'s worktrees. The same requirement can
 * appear in several worktrees (e.g. merged into main and still on its branch);
 * the copy changed most recently wins.
 */
export function listFeatures(repo: string): FeatureSummary[] {
  const byName = new Map<string, FeatureSummary>();
  for (const worktree of worktrees(repo)) {
    const root = path.join(worktree.path, FEATURES_DIR);
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      const summary = summarize(worktree, name);
      if (!summary) continue;
      const seen = byName.get(name);
      if (!seen || summary.updatedAt > seen.updatedAt) byName.set(name, summary);
    }
  }
  return [...byName.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Same directory, following symlinks (e.g. macOS /tmp) and the platform's case rules. */
function isSameDir(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return samePath(real(a), real(b));
}

export function describeFeatures(features: FeatureSummary[], here: string): string {
  if (features.length === 0) return "这个项目里还没有需求（docs/features 下没有 spec.md）。";
  const lines = [`共 ${features.length} 个需求（按最近更新排序）：`, ""];
  features.forEach((f, i) => {
    const facts = [
      f.stage,
      f.type,
      f.profile ? `${PROFILE_LABELS[f.profile]}档` : null,
      f.specVersion && f.specVersion > 1 ? `需求第 ${f.specVersion} 版` : null,
      `更新于 ${new Date(f.updatedAt).toLocaleString("zh-CN", { hour12: false })}`,
    ].filter(Boolean);
    lines.push(`${i + 1}. ${f.title}（${f.featureDir}）`);
    lines.push(`   ${facts.join("；")}`);
    const where = isSameDir(f.worktree, here) ? "当前工作区" : `工作区 ${f.worktree}`;
    lines.push(`   位置：${where}${f.branch ? `，分支 ${f.branch}` : ""}`);
    if (f.usage) lines.push(`   用时与用量：${f.usage}`);
  });
  return lines.join("\n");
}

/**
 * Lets people name a requirement the short way. Accepts a feature directory
 * (docs/features/20261012-sms-login), its name (20261012-sms-login) or a unique part
 * of the name (sms-login). Returns the directory relative to the repository, "/"-separated.
 */
export function resolveFeatureArg(repo: string, arg: string): string {
  const trimmed = arg.trim().replace(/[\\/]+$/, "");
  if (/[\\/]/.test(trimmed) || fs.existsSync(path.join(repo, trimmed, "spec.md"))) return trimmed;
  const root = path.join(repo, FEATURES_DIR);
  const prefix = FEATURES_DIR.split(path.sep).join("/");
  const names = fs.existsSync(root) ? fs.readdirSync(root).filter((n) => fs.existsSync(path.join(root, n, "spec.md"))) : [];
  if (names.includes(trimmed)) return `${prefix}/${trimmed}`;
  const matches = names.filter((n) => n.toLowerCase().includes(trimmed.toLowerCase()));
  if (matches.length === 1) return `${prefix}/${matches[0]}`;
  if (matches.length > 1) {
    throw new Error(`"${arg}" 对应多个需求：${matches.join("、")}。请写完整的名称。`);
  }
  throw new Error(`在 ${prefix} 下没有找到 "${arg}" 对应的需求。用 --list 查看全部需求。`);
}

/** Requirements in this worktree that have been handed to the pipeline at least once. */
export function featuresWithRuns(repo: string): string[] {
  const root = path.join(repo, FEATURES_DIR);
  if (!fs.existsSync(root)) return [];
  const prefix = FEATURES_DIR.split(path.sep).join("/");
  return fs
    .readdirSync(root)
    .filter((n) => fs.existsSync(path.join(root, n, ".pipeline", "state.json")))
    .map((n) => `${prefix}/${n}`);
}

/** A requirement developed in a worktree that the pipeline created for it, from `sourceRepo`. */
export interface WorktreeRun {
  repo: string;
  featureDir: string;
  workspaceId: string;
}

/**
 * Finds the worktree run of a requirement started from this checkout (--worktree), by
 * feature directory or by (part of) its name. Null when there is none.
 */
export function findWorktreeRun(sourceRepo: string, feature: string): WorktreeRun | null {
  const wanted = feature.trim().replace(/[\\/]+$/, "");
  const name = wanted.split(/[\\/]/).pop() ?? wanted;
  const prefix = FEATURES_DIR.split(path.sep).join("/");
  const matches: WorktreeRun[] = [];
  for (const wt of worktrees(sourceRepo)) {
    if (isSameDir(wt.path, sourceRepo)) continue;
    const root = path.join(wt.path, FEATURES_DIR);
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      if (!(dir === name || dir.toLowerCase().includes(name.toLowerCase()))) continue;
      try {
        const state = JSON.parse(fs.readFileSync(path.join(root, dir, ".pipeline", "state.json"), "utf8")) as {
          worktree?: { workspaceId?: string; sourceRepo?: string } | null;
          status?: string;
          phase?: string;
        };
        // The chat it was started from; or, for testing, any chat of the same repository (ADR 0022).
        const forTesting = state.status === "phase_done" || state.phase === "verify";
        if (state.worktree?.workspaceId && state.worktree.sourceRepo && (isSameDir(state.worktree.sourceRepo, sourceRepo) || forTesting)) {
          matches.push({ repo: fs.realpathSync(wt.path), featureDir: `${prefix}/${dir}`, workspaceId: state.worktree.workspaceId });
        }
      } catch {
        // No run there.
      }
    }
  }
  const exact = matches.filter((m) => m.featureDir.endsWith(`/${name}`));
  return (exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null) ?? null;
}
