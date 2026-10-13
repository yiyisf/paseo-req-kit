// Overview of every requirement in a repository, across all of its worktrees.
//
// Each requirement normally lives on its own worktree and branch, so a committed
// index file would conflict on every merge. The overview is generated instead:
// `start-pipeline --list` prints it, and /req uses it for status and takeover.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PROFILE_LABELS, type ProfileName } from "./config.js";
import { isSpecConfirmed, specProfile } from "./preflight.js";
import { isAlive } from "./state.js";

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
      current = { path: line.slice("worktree ".length).trim(), branch: null };
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
    case "failed":
      return "已中断（可继续）";
    case "completed":
      return state.outcome === "not_completed" ? "开发结束，未完成" : "待验收";
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
    const where = path.resolve(f.worktree) === path.resolve(here) ? "当前工作区" : `工作区 ${f.worktree}`;
    lines.push(`   位置：${where}${f.branch ? `，分支 ${f.branch}` : ""}`);
  });
  return lines.join("\n");
}
