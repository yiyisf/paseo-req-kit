import { execFileSync } from "node:child_process";

export interface GitInfo {
  isRepo: boolean;
  /** Current branch; null when not a repository or HEAD is detached. */
  branch: string | null;
  detached: boolean;
  /** Branches that must never receive the pipeline's commits. */
  protectedBranches: string[];
}

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function gitInfo(repo: string): GitInfo {
  if (git(repo, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    return { isRepo: false, branch: null, detached: false, protectedBranches: [] };
  }
  // symbolic-ref works before the first commit, unlike rev-parse --abbrev-ref HEAD.
  const branch = git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const protectedBranches = new Set(["main", "master"]);
  const originHead = git(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead) protectedBranches.add(originHead.replace(/^origin\//, ""));
  return { isRepo: true, branch, detached: branch === null, protectedBranches: [...protectedBranches] };
}
