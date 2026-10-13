// --worktree: develop a requirement in a Paseo worktree workspace created for it.
// The chat stays where it is (its working directory never changes); the spec moves
// to the new worktree, is committed there on its own branch, and the step agents are
// placed in that workspace while remaining subagents of the chat. See ADR 0018.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AgentRuntime } from "./runtime.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export interface OwnWorktree {
  repo: string;
  workspaceId: string;
  branch: string;
  /** Whether the uncommitted copy in the chat's checkout was removed after moving. */
  removedSource: boolean;
}

export async function moveToOwnWorktree(input: {
  runtime: Pick<AgentRuntime, "createWorktree">;
  sourceRepo: string;
  featureDir: string;
  originAgentId: string | null;
  title: string;
}): Promise<OwnWorktree> {
  const { sourceRepo, featureDir } = input;
  const branch = `feature/${path.basename(featureDir)}`;
  try {
    git(sourceRepo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
    throw new Error(`分支 ${branch} 已经存在。这个需求可能已经有自己的工作区了：用 --list 查看，或在那个工作区的对话中继续。`);
  } catch (error) {
    if ((error as Error).message.startsWith("分支")) throw error;
    // show-ref failed: the branch does not exist yet, as expected.
  }
  const head = git(sourceRepo, "rev-parse", "--abbrev-ref", "HEAD");
  const baseRef = head === "HEAD" ? git(sourceRepo, "rev-parse", "HEAD") : head;

  const created = await input.runtime.createWorktree({
    sourceRepo,
    baseRef,
    branchName: branch,
    title: input.title,
    callerAgentId: input.originAgentId,
  });
  const repo = fs.realpathSync(created.directory);

  // The spec and interview notes were written in the chat's checkout; move them over.
  const from = path.join(sourceRepo, featureDir);
  const to = path.join(repo, featureDir);
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true, filter: (src) => path.basename(src) !== ".pipeline" });
  git(repo, "add", "--", featureDir);
  const staged = git(repo, "diff", "--cached", "--name-only", "--", featureDir);
  if (staged) {
    try {
      git(repo, "commit", "-q", "-m", `docs(req): ${input.title} 需求说明`, "--", featureDir);
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim();
      throw new Error(`在新工作区 ${repo} 中提交需求说明失败：${stderr || (error as Error).message}`);
    }
  }

  // Leave nothing behind in the chat's checkout unless it was already committed there.
  const tracked = git(sourceRepo, "ls-files", "--", featureDir);
  const removedSource = tracked === "";
  if (removedSource) fs.rmSync(from, { recursive: true, force: true });
  return { repo, workspaceId: created.workspaceId, branch, removedSource };
}
