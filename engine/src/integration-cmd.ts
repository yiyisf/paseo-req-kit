// `req integration` and `req sync` (1.9, ADR 0028).
//
//   req integration test [需求]   what each configured integration would run, without running it
//   req integration fields        the card fields /req confirms with the spec (card.json)
//   req sync <需求>               bring the requirement's cards up to date now: send what failed,
//                                 create a missing card, set the state for where the requirement is

import path from "node:path";
import { locate } from "./api.js";
import { loadConfig, type PipelineConfig } from "./config.js";
import {
  cardFieldsText,
  commandAvailable,
  describeExternal,
  INTEGRATION_EVENT_LABELS,
  INTEGRATION_EVENTS,
  type IntegrationConfig,
  type IntegrationEvent,
  placeholderValues,
  renderArgs,
  resolveCommand,
  statusFor,
  syncIntegration,
} from "./integrations.js";
import { defaultConfigPath } from "./locations.js";
import { acquireLock, isAlive, type PipelineState, readState, statePath, writeState } from "./state.js";

/** The event that describes where a requirement is now. */
export function eventForState(state: Pick<PipelineState, "status" | "phase" | "pid">): IntegrationEvent {
  switch (state.status) {
    case "waiting_for_approval":
      return "approval";
    case "waiting_for_business":
      return "blocked";
    case "phase_done":
      return "phase_done";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return state.phase === "verify" ? "verify" : "started";
  }
}

function quoteArg(a: string): string {
  const shown = a.length > 120 ? `${a.slice(0, 117)}…` : a;
  return /^[^\s"'\\$`&|;<>()*?!]+$/.test(shown) ? shown : `"${shown.replace(/\n/g, "\\n").replace(/"/g, '\\"')}"`;
}

function testIntegration(config: IntegrationConfig, project: PipelineConfig, target: { repo: string; featureDir: string; state: PipelineState | null } | null): string[] {
  const lines = [`== ${config.name}（命令 ${config.command}）`];
  const { file, prefix } = resolveCommand(config.command);
  lines.push(commandAvailable(config.command) ? `✓ 找到命令：${[file, ...prefix].join(" ")}` : `✗ 找不到命令 ${config.command}：请确认它已安装并在 PATH 中（运行 Paseo daemon 的用户的 PATH）`);
  const ctx = {
    repo: target?.repo ?? process.cwd(),
    featureDir: target?.featureDir ?? "docs/features/20261015-示例需求",
    state: { branch: target?.state?.branch ?? "feature/示例", profile: target?.state?.profile ?? "standard", type: target?.state?.type ?? null, outcome: target?.state?.outcome ?? null, external: target?.state?.external ?? null },
    projectDefaults: project.integrationDefaults[config.name],
  } as Parameters<typeof placeholderValues>[1];
  if (!target) lines.push("（没有指定需求：用示例值；指定一个需求可以看到用它的需求说明和 card.json 填出的命令）");
  const show = (label: string, args: string[], status?: string | null, event?: IntegrationEvent) => {
    try {
      const values = placeholderValues(config, ctx, { status, event });
      if (!values.id) values.id = "<卡片编号>";
      lines.push(`${label}：${config.command} ${renderArgs(args, values).map(quoteArg).join(" ")}`);
    } catch (error) {
      lines.push(`${label}：✗ ${(error as Error).message}`);
    }
  };
  if (config.create) show("建卡", config.create.args);
  for (const event of INTEGRATION_EVENTS) {
    const status = statusFor(config, event, null);
    if (status && config.status) show(`${INTEGRATION_EVENT_LABELS[event]} → 「${status}」`, config.status.args, status, event);
  }
  for (const outcome of ["completed_with_issues", "not_completed"] as const) {
    const status = config.statusMap?.[outcome];
    if (status && config.status) show(`完成（${outcome === "not_completed" ? "未完成" : "有遗留问题"}）→ 「${status}」`, config.status.args, status, "completed");
  }
  return lines;
}

async function main(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const cwd = process.cwd();
  const configPath = defaultConfigPath();
  if (sub === "fields") {
    const config = loadConfig(configPath, cwd).config;
    console.log(cardFieldsText(config.integrations) ?? "没有配置外部系统对接（integrations）。");
    return 0;
  }
  if (sub === "test") {
    let target: { repo: string; featureDir: string; state: PipelineState | null } | null = null;
    if (rest[0]) {
      const found = locate(cwd, rest[0]);
      target = { ...found, state: readState(statePath(found.repo, found.featureDir)) };
    }
    const config = loadConfig(configPath, target?.repo ?? cwd).config;
    if (config.integrations.length === 0) {
      console.log("没有配置外部系统对接（integrations）。写法见 docs/guide/项目定制与运行规则.md 的“外部系统对接”。");
      return 0;
    }
    console.log("只显示将要执行的命令，不会真正调用。\n");
    for (const i of config.integrations) console.log(`${testIntegration(i, config, target).join("\n")}\n`);
    return 0;
  }
  if (sub === "sync") {
    if (!rest[0]) {
      console.error("请写出是哪个需求，例如：req sync sms-login");
      return 2;
    }
    const { repo, featureDir } = locate(cwd, rest[0]);
    const file = statePath(repo, featureDir);
    const state = readState(file);
    if (!state) {
      console.log(`${featureDir} 还没有启动过开发流水线，没有要同步的。`);
      return 0;
    }
    if (state.status === "running" && isAlive(state.pid)) {
      console.log("流水线正在运行：它会在下一个阶段变化时自动补发。现在不需要 req sync。");
      return 0;
    }
    const config = loadConfig(configPath, repo).config;
    if (config.integrations.length === 0) {
      console.log("没有配置外部系统对接（integrations）。");
      return 0;
    }
    const release = acquireLock(repo, featureDir);
    try {
      const event = eventForState(state);
      for (const i of config.integrations) {
        await syncIntegration({
          config: i,
          ctx: { repo, featureDir, state, projectDefaults: config.integrationDefaults[i.name] },
          event,
          log: (m) => console.log(m),
        });
      }
      writeState(file, state);
    } finally {
      release();
    }
    const lines = describeExternal(state.external);
    console.log(lines.length > 0 ? `\n${lines.join("\n")}` : "");
    return Object.values(state.external ?? {}).some((r) => r.pending.length > 0) ? 1 : 0;
  }
  console.error("用法：req integration test [需求] | req integration fields | req sync <需求>");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: Error) => {
      console.error(error.message);
      process.exit(2);
    },
  );
}

export { main as integrationMain };
