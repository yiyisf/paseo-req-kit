// The quality gate: project checks (lint, type check, tests, build) that the engine runs
// itself after the steps that change code, instead of trusting the agent's own report.
// Only checks that passed before the change and fail after it block; see ADR 0023.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CheckDef } from "./config.js";
import type { CheckOutcome } from "./state.js";

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

export function headCommit(repo: string): string | null {
  return git(repo, ["rev-parse", "HEAD"])?.trim() || null;
}

/**
 * Files changed since `base`: committed, staged, unstaged and untracked (repository-relative,
 * "/" separators). Null when it cannot be told (not a git repository, unknown base).
 */
export function changedFiles(repo: string, base: string | null): string[] | null {
  if (!base) return null;
  const diff = git(repo, ["diff", "--name-only", base]);
  if (diff === null) return null;
  const untracked = git(repo, ["ls-files", "--others", "--exclude-standard"]) ?? "";
  const files = new Set([...diff.split("\n"), ...untracked.split("\n")].map((f) => f.trim()).filter(Boolean));
  return [...files].sort();
}

/**
 * Which of `files` changed since `commit` (committed or not); null when the commit is not
 * in this repository. Used to tell whether acceptance tests committed first were changed later.
 */
export function changedSince(repo: string, commit: string, files: string[]): string[] | null {
  if (git(repo, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]) === null) return null;
  const out = git(repo, ["diff", "--name-only", commit, "--", ...files]);
  if (out === null) return null;
  return out.split("\n").map((f) => f.trim()).filter(Boolean).sort();
}

function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i += 1;
      if (pattern[i + 1] === "/") i += 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Whether a repository-relative file falls under a path: "web/" (a directory), "src/a.ts", or a glob with *. */
export function matchesPath(file: string, pattern: string): boolean {
  const p = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (p === "" || p === "." || p === "/") return true;
  if (p.includes("*") || p.includes("?")) return globToRegExp(p).test(file);
  if (p.endsWith("/")) return file.startsWith(p);
  return file === p || file.startsWith(`${p}/`);
}

/** The paths a check watches; empty: the whole repository. */
export function checkPaths(check: CheckDef): string[] {
  if (check.paths && check.paths.length > 0) return check.paths;
  if (check.cwd && check.cwd !== ".") return [`${check.cwd.replace(/\\/g, "/").replace(/\/$/, "")}/`];
  return [];
}

/** Whether a check applies to a change; with the changed files unknown, every check applies. */
export function checkApplies(check: CheckDef, files: string[] | null): boolean {
  const paths = checkPaths(check);
  if (paths.length === 0 || files === null) return true;
  return files.some((f) => paths.some((p) => matchesPath(f, p)));
}

export interface CheckRun {
  outcome: CheckOutcome;
  /** Exit code, or null when it was stopped (timeout) or could not start. */
  exitCode: number | null;
  timedOut: boolean;
  /** Combined output, trimmed to the end. */
  output: string;
  seconds: number;
}

const MAX_OUTPUT = 200_000;

/** Runs one check through the system shell, in the repository (or its cwd). Never throws. */
export function runCheck(check: CheckDef, repo: string, defaultTimeoutMinutes: number): Promise<CheckRun> {
  const started = Date.now();
  const cwd = path.join(repo, check.cwd ?? ".");
  const timeoutMs = (check.timeoutMinutes ?? defaultTimeoutMinutes) * 60_000;
  return new Promise((resolve) => {
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > MAX_OUTPUT * 2) output = output.slice(-MAX_OUTPUT);
    };
    const finish = (exitCode: number | null, timedOut: boolean, extra = "") => {
      const text = `${output}${extra}`.slice(-MAX_OUTPUT);
      resolve({ outcome: exitCode === 0 && !timedOut ? "pass" : "fail", exitCode, timedOut, output: text, seconds: Math.round((Date.now() - started) / 1000) });
    };
    if (!fs.existsSync(cwd)) {
      finish(null, false, `检查的目录不存在：${cwd}`);
      return;
    }
    let child;
    try {
      // CI=1: test runners stay non-interactive (no watch mode, no prompts).
      child = spawn(check.command, { cwd, shell: true, env: { ...process.env, CI: process.env.CI ?? "1" }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (error) {
      finish(null, false, `无法启动：${(error as Error).message}`);
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // The whole process group: a test runner's own children too.
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, timeoutMs);
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      clearTimeout(timer);
      finish(null, false, `\n无法启动：${error.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code, timedOut, timedOut ? `\n（超过 ${check.timeoutMinutes ?? defaultTimeoutMinutes} 分钟，已停止）` : "");
    });
  });
}

/** The last lines of a check's output, for a message to the agent. */
export function tail(text: string, lines = 60): string {
  const all = text.trimEnd().split(/\r?\n/);
  return (all.length > lines ? ["…", ...all.slice(-lines)] : all).join("\n");
}

/** A file name for a check's log. */
export function logName(name: string): string {
  return `${name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "check"}.log`;
}
