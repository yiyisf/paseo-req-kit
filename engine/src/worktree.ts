// --worktree: develop a requirement in a Paseo worktree workspace created for it.
// The chat stays where it is (its working directory never changes); the spec moves
// to the new worktree, is committed there on its own branch, and the step agents are
// placed in that workspace while remaining subagents of the chat. See ADR 0018.
//
// 1.14: the move can be done again. What was created is written down first
// (~/.req-kit/worktrees/<key>.json), so a start that failed after the worktree existed (the
// launcher gave up waiting, the check before starting failed) continues in that worktree the
// next time instead of stopping at "the branch already exists" and leaving a branch with only
// the spec on it. The alignment's other files (GLOSSARY.md, docs/adr/) go along with the spec.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { kitHome } from "./locations.js";
import { registerRequirement, requirementKey } from "./records.js";
import type { AgentRuntime } from "./runtime.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** `git status --porcelain` lines as they are (a leading space is part of the format). */
function porcelain(cwd: string, ...args: string[]): string[] {
  try {
    return execFileSync("git", ["status", "--porcelain", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .split("\n")
      .filter((l) => l.length > 3);
  } catch {
    return [];
  }
}

function gitOrNull(cwd: string, ...args: string[]): string | null {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
}

export interface OwnWorktree {
  repo: string;
  workspaceId: string;
  branch: string;
  /** Whether the uncommitted copy in the chat's checkout was removed after moving. */
  removedSource: boolean;
  /** 1.14: an earlier start had created this worktree already; it is used again. */
  reused: boolean;
  /** 1.14: files outside the feature directory the alignment changed, carried over (relative paths). */
  carried: string[];
  /** 1.14: things the person should know about where the branch starts. */
  warnings: string[];
}

/** What a start created, written before anything else is done in the new worktree. */
export interface WorktreeRecord {
  schema: 1;
  sourceRepo: string;
  featureDir: string;
  repo: string;
  workspaceId: string;
  branch: string;
  baseRef: string;
  createdAt: string;
  originAgentId: string | null;
}

export function worktreeRecordsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(kitHome(env), "worktrees");
}

function recordFile(sourceRepo: string, featureDir: string, env: NodeJS.ProcessEnv): string {
  return path.join(worktreeRecordsDir(env), `${requirementKey(sourceRepo, featureDir)}.json`);
}

export function readWorktreeRecord(sourceRepo: string, featureDir: string, env: NodeJS.ProcessEnv = process.env): WorktreeRecord | null {
  try {
    return JSON.parse(fs.readFileSync(recordFile(sourceRepo, featureDir, env), "utf8")) as WorktreeRecord;
  } catch {
    return null;
  }
}

/** Every recorded worktree whose directory still exists. */
export function listWorktreeRecords(env: NodeJS.ProcessEnv = process.env): WorktreeRecord[] {
  const dir = worktreeRecordsDir(env);
  if (!fs.existsSync(dir)) return [];
  const out: WorktreeRecord[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as WorktreeRecord;
      if (r.repo && fs.existsSync(r.repo)) out.push(r);
    } catch {
      // A broken record is skipped.
    }
  }
  return out;
}

function writeRecord(record: WorktreeRecord, env: NodeJS.ProcessEnv): void {
  const file = recordFile(record.sourceRepo, record.featureDir, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

/** The directory of the git worktree that has `branch` checked out, if any. */
function worktreeOfBranch(sourceRepo: string, branch: string): string | null {
  const list = gitOrNull(sourceRepo, "worktree", "list", "--porcelain") ?? "";
  let current: string | null = null;
  for (const line of list.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length).trim();
    else if (line.trim() === `branch refs/heads/${branch}` && current) return current;
  }
  return null;
}

/** Files the requirement interview may change outside the feature directory. */
const ALIGNMENT_FILES = ["GLOSSARY.md", "CONTEXT.md", "docs/adr"];

/** Uncommitted alignment changes in the chat's checkout (new or modified files, relative paths). */
export function alignmentChanges(sourceRepo: string): string[] {
  return porcelain(sourceRepo, "--untracked-files=all", "--", ...ALIGNMENT_FILES)
    .filter((l) => !l.startsWith(" D") && !l.startsWith("D "))
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
    .filter((p) => p && !p.includes(" -> "));
}

/** Where the new branch starts and what is left behind, in plain words. */
export function baseWarnings(sourceRepo: string, featureDir: string, head: string): string[] {
  const warnings: string[] = [];
  if (gitOrNull(sourceRepo, "ls-files", "--", featureDir)) {
    warnings.push(`需求文件已经提交在 ${head} 上（应该只提交在需求自己的分支上）。新分支照样从这里开始；${head} 上的这个提交请开发同事看一下，还没推送的话可以撤掉，流水线不会改动它。`);
  }
  const behind = Number(gitOrNull(sourceRepo, "rev-list", "--count", "HEAD..@{upstream}") ?? "0");
  if (behind > 0) warnings.push(`本地的 ${head} 比远端落后 ${behind} 个提交（按上次拉取的结果），新分支从本地的 ${head} 开始；需要最新代码时，先拉取再重新开始。`);
  const others = porcelain(sourceRepo, "--untracked-files=all")
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
    .filter((p) => p && !p.startsWith(featureDir.split(path.sep).join("/")) && !ALIGNMENT_FILES.some((a) => p === a || p.startsWith(`${a}/`)));
  if (others.length > 0) warnings.push(`这个目录里还有 ${others.length} 处未提交的改动和这个需求无关，没有带到新工作区（例如 ${others.slice(0, 3).join("、")}）。`);
  return warnings;
}

export async function moveToOwnWorktree(input: {
  runtime: Pick<AgentRuntime, "createWorktree"> & Partial<Pick<AgentRuntime, "openWorkspace">>;
  sourceRepo: string;
  featureDir: string;
  originAgentId: string | null;
  title: string;
  env?: NodeJS.ProcessEnv;
}): Promise<OwnWorktree> {
  const env = input.env ?? process.env;
  const { sourceRepo, featureDir } = input;
  const branch = `feature/${path.basename(featureDir)}`;
  const branchExists = gitOrNull(sourceRepo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`) !== null;
  const head = git(sourceRepo, "rev-parse", "--abbrev-ref", "HEAD");
  const baseRef = head === "HEAD" ? git(sourceRepo, "rev-parse", "HEAD") : head;

  let repo: string;
  let workspaceId: string;
  let reused = false;
  let warnings: string[] = [];
  const record = readWorktreeRecord(sourceRepo, featureDir, env);
  if (branchExists && record && fs.existsSync(record.repo) && worktreeOfBranch(sourceRepo, branch)) {
    // An earlier start made it and stopped before the pipeline ran there.
    repo = fs.realpathSync(record.repo);
    workspaceId = record.workspaceId;
    reused = true;
  } else if (branchExists) {
    const dir = worktreeOfBranch(sourceRepo, branch);
    if (!dir) {
      throw new Error(
        `分支 ${branch} 已经存在，但没有对应的工作区目录。如果它是以前没有启动成功留下的空分支，请开发同事确认后删除它（git branch -D ${branch}）再重新开始；否则请把功能目录换一个名字。`,
      );
    }
    if (!input.runtime.openWorkspace) throw new Error(`分支 ${branch} 已经有工作区 ${dir}，但这个 Paseo 版本不能接手已有的目录。请在 Paseo 中打开那个工作区，在那里的对话中开始开发。`);
    // A worktree made by an older version (no record): let Paseo take the directory as a workspace.
    workspaceId = (await input.runtime.openWorkspace(dir)).workspaceId;
    repo = fs.realpathSync(dir);
    reused = true;
  } else {
    warnings = baseWarnings(sourceRepo, featureDir, head);
    const created = await input.runtime.createWorktree({ sourceRepo, baseRef, branchName: branch, title: input.title, callerAgentId: input.originAgentId });
    repo = fs.realpathSync(created.directory);
    workspaceId = created.workspaceId;
  }
  // Written down before anything else happens there, so a failure after this point can be continued.
  writeRecord({ schema: 1, sourceRepo: fs.realpathSync(sourceRepo), featureDir, repo, workspaceId, branch, baseRef: record?.baseRef ?? baseRef, createdAt: record?.createdAt ?? new Date().toISOString(), originAgentId: input.originAgentId }, env);

  // The plugin lists it where it now lives, still under the chat's project.
  registerRequirement({ repo, featureDir, worktree: { workspaceId, sourceRepo: fs.realpathSync(sourceRepo) } }, env, input.originAgentId);

  // The spec and interview notes were written in the chat's checkout; move them over.
  const from = path.join(sourceRepo, featureDir);
  const to = path.join(repo, featureDir);
  if (fs.existsSync(from)) {
    fs.mkdirSync(to, { recursive: true });
    fs.cpSync(from, to, { recursive: true, filter: (src) => path.basename(src) !== ".pipeline" });
  }
  if (!fs.existsSync(path.join(to, "spec.md"))) throw new Error(`新工作区 ${repo} 中没有找到需求说明 ${featureDir}/spec.md`);
  // The terms and decisions the interview wrote down belong to the requirement too.
  const carried = alignmentChanges(sourceRepo);
  for (const rel of carried) {
    const src = path.join(sourceRepo, rel);
    if (!fs.existsSync(src) || fs.statSync(src).isDirectory()) continue;
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.copyFileSync(src, path.join(repo, rel));
  }
  git(repo, "add", "--", featureDir, ...carried);
  const staged = git(repo, "diff", "--cached", "--name-only", "--", featureDir, ...carried);
  if (staged) {
    try {
      git(repo, "commit", "-q", "-m", `docs(req): ${input.title} 需求说明`, "--", featureDir, ...carried);
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim();
      throw new Error(`在新工作区 ${repo} 中提交需求说明失败：${stderr || (error as Error).message}`);
    }
  }

  // Leave nothing behind in the chat's checkout unless it was already committed there. The
  // carried GLOSSARY.md / ADR changes stay: they may sit next to edits that are not ours.
  const tracked = gitOrNull(sourceRepo, "ls-files", "--", featureDir) ?? "";
  const removedSource = tracked === "" && fs.existsSync(from);
  if (removedSource) fs.rmSync(from, { recursive: true, force: true });
  return { repo, workspaceId, branch, removedSource: removedSource || (tracked === "" && !fs.existsSync(from)), reused, carried, warnings };
}
