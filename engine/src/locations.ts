import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Where things live.
//
//   <kit root>/                 one installed version of req-kit, e.g. ~/tools/req-kit/versions/1.0.0
//     bin/start-pipeline.mjs    launcher the /req skill runs
//     engine/prompts/           step prompts shipped with this version
//     principles/INDEX.md       principles shared by the chat skills and the step prompts
//   <kit home>/                 machine settings that survive upgrades, default ~/.req-kit
//     config.json               machine configuration
//     prompts.local/            machine-wide prompt overrides (same file names as engine/prompts)

export const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const KIT_ROOT = path.resolve(ENGINE_DIR, "..");
export const LAUNCHER = path.join(KIT_ROOT, "bin", "start-pipeline.mjs");
export const PROMPTS_DIR = path.join(ENGINE_DIR, "prompts");
export const PRINCIPLES_INDEX = path.join(KIT_ROOT, "principles", "INDEX.md");

/** Machine settings directory. REQ_KIT_HOME overrides it (tests, or several setups on one machine). */
export function kitHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.REQ_KIT_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".req-kit");
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(kitHome(env), "config.json");
}

export function localPromptsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(kitHome(env), "prompts.local");
}

export function kitVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
