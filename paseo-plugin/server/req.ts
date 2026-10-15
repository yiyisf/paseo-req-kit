// Runs `req api …` with the req-kit version this machine has active, and parses its one line
// of JSON (contracts/cli-json.md). The plugin never reads or writes req-kit's files itself.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class ReqError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function kitHomeOf(configured: string): string {
  if (configured.trim()) return path.resolve(configured.trim().replace(/^~(?=$|[\\/])/, os.homedir()));
  const env = process.env.REQ_KIT_HOME?.trim();
  return env ? path.resolve(env) : path.join(os.homedir(), ".req-kit");
}

/** The active version's req.mjs, from <kit home>/active.json. */
export function activeReq(kitHome: string): string {
  const file = path.join(kitHome, "active.json");
  let active: { root?: string; version?: string } | null = null;
  try {
    active = JSON.parse(fs.readFileSync(file, "utf8")) as { root?: string };
  } catch {
    throw new ReqError("no_kit", `这台机器上没有找到 req-kit（${file}）。请先安装 req-kit 并运行 req setup。`);
  }
  const req = active?.root ? path.join(active.root, "bin", "req.mjs") : "";
  if (!req || !fs.existsSync(req)) throw new ReqError("no_kit", `req-kit 当前启用的版本不在了（${active?.root ?? "未知"}）。请运行 req versions 和 req use。`);
  return req;
}

/** A node to run req with: this process's when it is node, else the one on PATH. */
function nodeBinary(): string {
  const base = path.basename(process.execPath).toLowerCase();
  return base === "node" || base === "node.exe" ? process.execPath : "node";
}

export interface ReqRunner {
  (args: string[], options?: { timeoutMs?: number }): Promise<unknown>;
}

/** Runs `req api <args>` and returns its data, or throws ReqError with req's message. */
export function reqApi(kitHome: () => string): ReqRunner {
  return (args, options = {}) =>
    new Promise((resolve, reject) => {
      let req: string;
      const home = kitHome();
      try {
        req = activeReq(home);
      } catch (error) {
        reject(error);
        return;
      }
      const env: NodeJS.ProcessEnv = { ...process.env, REQ_KIT_HOME: home };
      // Not a chat: the run keeps reporting to the chat that started it.
      delete env.PASEO_AGENT_ID;
      delete env.PASEO_AGENT_CWD;
      execFile(
        nodeBinary(),
        [req, "api", ...args],
        { env, timeout: options.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          const line = stdout.trim().split("\n").pop() ?? "";
          let parsed: { schema?: number; data?: unknown; error?: { code: string; message: string } } | null = null;
          try {
            parsed = JSON.parse(line);
          } catch {
            parsed = null;
          }
          if (parsed?.error) return reject(new ReqError(parsed.error.code, parsed.error.message));
          if (parsed && "data" in parsed) return resolve(parsed.data);
          const why = (stderr || error?.message || "没有输出").trim().split("\n").slice(-3).join(" ");
          if (/没有 "api" 这个命令|not.*api/i.test(stdout + stderr)) {
            return reject(new ReqError("old_kit", "本机的 req-kit 太旧，不支持插件（需要 1.9 或更新的版本）。请运行 req upgrade。"));
          }
          reject(new ReqError("failed", `req api ${args[0] ?? ""} 失败：${why}`));
        },
      );
    });
}

/** The same call made twice within `ms` shares one run (several open screens, one daemon). */
export function coalesce<T>(ms: number, run: () => Promise<T>): () => Promise<T> {
  let last: { at: number; value: Promise<T> } | null = null;
  return () => {
    const now = Date.now();
    if (last && now - last.at < ms) return last.value;
    const value = run();
    last = { at: now, value };
    value.catch(() => {
      if (last?.value === value) last = null;
    });
    return value;
  };
}
