// `req try <需求> [--stop]` (1.14): runs a finished requirement so the requester can try it,
// without knowing how to start the project. The project's paseo.json services are started in the
// requirement's own workspace through Paseo (each on its own port), and the addresses are given
// with what the handoff note says about test accounts and data. Projects without Paseo-managed
// services get the start instructions the pipeline wrote down, and the advice to ask the chat.
import fs from "node:fs";
import path from "node:path";
import { section } from "./checklist.js";
import { DEFAULT_CONFIG, loadConfig, type PipelineConfig } from "./config.js";
import { defaultConfigPath } from "./locations.js";
import type { AgentRuntime, ServiceTarget } from "./runtime.js";
import { isAlive, readState, statePath } from "./state.js";

export interface TryResult {
  ok: boolean;
  message: string;
  services: Array<{ name: string; url: string | null; running: boolean; output: string | null }>;
  /** How to start it and what test data to use, from handoff.md / service-start.md. */
  howTo: string[];
  stopped?: boolean;
}

function read(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

const tidy = (lines: string[]) => lines.map((l) => l.replace(/\s+$/, "")).filter((l, i, all) => l.trim() || (i > 0 && all[i - 1].trim())).slice(0, 40);

/** What the pipeline wrote about running it and the data to use. */
export function howToTry(featureAbs: string): string[] {
  const handoff = read(path.join(featureAbs, "handoff.md"));
  const run = section(handoff, /怎么跑起来|如何运行|启动/);
  const data = section(handoff, /测试需要的准备|测试数据|账号/);
  const start = run.length ? run : section(read(path.join(featureAbs, "service-start.md")), /启动方法|怎么启动|启动/);
  return tidy([...(start.length ? ["怎么跑起来：", ...start] : []), ...(data.length ? ["", "测试需要的准备：", ...data] : [])]);
}

interface TryRecord {
  at: string;
  target: ServiceTarget;
  names: string[];
}

const recordFile = (featureAbs: string) => path.join(featureAbs, ".pipeline", "try.json");

export async function tryRequirement(input: { repo: string; featureDir: string; stop?: boolean; runtime: Pick<AgentRuntime, "listServices" | "startServices" | "stopServices">; config: PipelineConfig }): Promise<TryResult> {
  const featureAbs = path.join(input.repo, input.featureDir);
  const state = readState(statePath(input.repo, input.featureDir));
  const howTo = howToTry(featureAbs);
  if (input.stop) {
    let rec: TryRecord | null = null;
    try {
      rec = JSON.parse(fs.readFileSync(recordFile(featureAbs), "utf8")) as TryRecord;
    } catch {
      rec = null;
    }
    if (!rec) return { ok: true, message: "没有由试用启动的服务，不用停止。", services: [], howTo, stopped: false };
    await input.runtime.stopServices(rec.target, rec.names);
    fs.rmSync(recordFile(featureAbs), { force: true });
    return { ok: true, message: `已停止试用的服务：${rec.names.join("、")}。`, services: [], howTo, stopped: true };
  }
  if (state && state.status === "running" && isAlive(state.pid)) {
    return { ok: false, message: "流水线还在运行，它会自己启动和停止服务。等开发结束后再试用。", services: [], howTo };
  }
  const target: ServiceTarget | null = state?.worktree?.workspaceId ? { workspaceId: state.worktree.workspaceId } : state?.originAgentId ? { agentId: state.originAgentId } : null;
  const names = target ? await input.runtime.listServices(target).catch(() => null) : null;
  if (!target || !names || names.length === 0) {
    return {
      ok: false,
      message:
        "这个项目没有用 Paseo 管理的服务脚本（paseo.json），不能一键启动。可以在这个需求的对话里说\"帮我把它跑起来\"，或按下面的方法启动；以后请开发同事运行 /req-setup 写好 paseo.json，就能一键试用。",
      services: [],
      howTo,
    };
  }
  const started = await input.runtime.startServices(target, names, input.config.serviceReadySeconds * 1000);
  fs.mkdirSync(path.dirname(recordFile(featureAbs)), { recursive: true });
  fs.writeFileSync(recordFile(featureAbs), JSON.stringify({ at: new Date().toISOString(), target, names } satisfies TryRecord, null, 2));
  const failed = started.filter((s) => !s.running);
  const services = started.map((s) => ({ name: s.name, url: s.url, running: s.running, output: s.running ? null : s.output }));
  const ok = failed.length === 0;
  const lines = started.map((s) => (s.running ? `- ${s.name}：${s.url ?? "已启动（没有网页地址）"}` : `- ${s.name}：没有启动成功`));
  return {
    ok,
    message: `${ok ? "已启动，可以试用了" : "有服务没有启动成功"}：\n${lines.join("\n")}\n用完后停止：req try ${path.basename(input.featureDir)} --stop（插件里点"停止试用"）。`,
    services,
    howTo,
  };
}

async function main(argv: string[]): Promise<number> {
  const stop = argv.includes("--stop");
  const json = argv.includes("--json");
  const feature = argv.find((a) => !a.startsWith("--"));
  if (!feature || argv.includes("--help") || argv.includes("-h")) {
    console.log("用法：req try <需求> [--stop]\n\n把做好的需求在它自己的工作区里跑起来，给出访问地址和测试数据，方便亲手试用；--stop 停止。");
    return feature ? 0 : 2;
  }
  const { locate } = await import("./api.js");
  const { repo, featureDir } = locate(process.cwd(), feature);
  let config: PipelineConfig;
  try {
    config = loadConfig(defaultConfigPath(), repo).config;
  } catch {
    config = DEFAULT_CONFIG;
  }
  const { loadRuntimeFactory } = await import("./runtime-loader.js");
  const runtime = await (await loadRuntimeFactory())({ config, log: () => undefined });
  try {
    const result = await tryRequirement({ repo, featureDir, stop, runtime, config });
    if (json) console.log(JSON.stringify(result));
    else {
      console.log(result.message);
      if (result.howTo.length) console.log(`\n${result.howTo.join("\n")}`);
    }
    return result.ok ? 0 : 1;
  } finally {
    await runtime.close().catch(() => undefined);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: Error) => {
      console.error(`没有启动：${error.message}`);
      process.exit(1);
    },
  );
}
