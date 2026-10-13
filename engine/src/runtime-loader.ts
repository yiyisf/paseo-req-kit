import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RuntimeFactory } from "./runtime.js";

export async function loadRuntimeFactory(): Promise<RuntimeFactory> {
  // Test hook: run the real orchestration against a scripted fake daemon.
  const fake = process.env.REQ_PIPELINE_FAKE_RUNTIME;
  if (fake) {
    const module = (await import(pathToFileURL(path.resolve(fake)).href)) as { createRuntime: RuntimeFactory };
    return module.createRuntime;
  }
  const module = await import("./paseo-runtime.js");
  return module.createRuntime;
}
