// The intake process (1.11, ADR 0030): a shared development machine takes cards on its own.
//
//   req factory once                 one look: start requirements for new cards, pass replies on
//   req factory run                  look every factory.pollMinutes until stopped (for a service manager)
//   req factory start | stop         run it in the background on this machine
//   req factory status               whether it runs, the last look, cards it could not take
//   req factory service              how to run it as a system service
//
// A card is taken when it is listed by the integration's `list` command for a space (projectId)
// some registered repository takes (cardSource), and its title starts with one of
// factory.titleTags. Starting is `req start --from` (beginFromCard); passing replies on is
// `req card check --all` (checkCards). Files: ~/.req-kit/factory/.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { cardRoutes, findCardEntry, hashText, parseJsonOutput } from "./card.js";
import { beginFromCard, type CardCmdOptions, cardIntegrations, checkCards, withRuntime } from "./card-cmd.js";
import { resumeCommand, statusCommand } from "./cli-args.js";
import { loadConfig, type PipelineConfig } from "./config.js";
import { watchdogPrompt } from "./messages.js";
import { dispatchNotifiers } from "./notifiers.js";
import { readIndex } from "./records.js";
import { type IntegrationConfig, renderArgs, runCommand, type Runner } from "./integrations.js";
import { defaultConfigPath, ENGINE_DIR, KIT_ROOT, kitHome, kitVersion } from "./locations.js";
import { isAlive, readState, statePath } from "./state.js";

const USAGE = `用法：
  req factory once      检查一次：为新卡片开始需求，把需求方的新回复转给需求会话
  req factory run       每隔 factory.pollMinutes 分钟检查一次，直到停止（给系统服务用）
  req factory start     在后台运行（日志：~/.req-kit/factory/factory.log）
  req factory stop      停止后台运行
  req factory status    是否在运行、最近一次检查、没能接的卡片
  req factory service   说明怎样作为系统服务运行（开机自动启动）`;

export interface ListedCard {
  id: string;
  title: string;
  state: string | null;
  subsystem: string | null;
  author: string | null;
}

interface Skipped {
  reason: string;
  /** Title and subsystem when it was skipped: a changed card is tried again. */
  key: string;
  at: string;
}

export interface PollResult {
  started: string[];
  skipped: string[];
  relayed: string[];
  /** 1.12: interrupted pipelines whose chat was asked to continue them. */
  resumed: string[];
  /** 1.12: what the self-check found wrong; no new cards are taken while it is not empty. */
  problems: string[];
  errors: string[];
  notes: string[];
}

export function factoryDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(kitHome(env), "factory");
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function at(value: unknown, dotted: string): unknown {
  let cur = value;
  for (const part of dotted.split(".").filter(Boolean)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** The list in a `list` command's output. */
export function listItems(parsed: unknown, itemsPath?: string): unknown[] {
  if (itemsPath) {
    const v = at(parsed, itemsPath);
    if (!Array.isArray(v)) throw new Error(`输出中 ${itemsPath} 不是列表（list.items）`);
    return v;
  }
  for (const p of ["data.list", "data.records", "data.items", "data.rows", "data", ""]) {
    const v = p ? at(parsed, p) : parsed;
    if (Array.isArray(v)) return v;
  }
  throw new Error("输出中没有找到卡片列表，请在 list.items 中写明它的位置（例如 \"data.list\"）");
}

/** All cards of a space the `list` command returns, page by page. */
export async function listCards(config: IntegrationConfig, projectId: string, titleTag: string, run: Runner = runCommand): Promise<ListedCard[]> {
  const list = config.list;
  if (!list) throw new Error(`${config.name} 没有配置 list（列出卡片的命令）`);
  const pageSize = list.pageSize ?? 100;
  const maxPages = list.maxPages ?? 5;
  const out: ListedCard[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const args = renderArgs(list.args, { projectId, page: String(page), pageSize: String(pageSize), titleTag });
    const result = await run(config.command, args, (config.timeoutSeconds ?? 60) * 1000);
    if (!result.ok) throw new Error(`列出空间 ${projectId} 的卡片失败：${result.error}`);
    let parsed: unknown;
    try {
      parsed = parseJsonOutput(result.output);
    } catch (error) {
      throw new Error(`列出空间 ${projectId} 的卡片：${(error as Error).message}`);
    }
    if (at(parsed, "success") === false) throw new Error(`列出空间 ${projectId} 的卡片失败：${String(at(parsed, "message") ?? "success 为 false")}`);
    const items = listItems(parsed, list.items);
    const str = (item: unknown, p: string | undefined) => {
      if (!p) return null;
      const v = at(item, p);
      return v === undefined || v === null ? null : String(v);
    };
    for (const item of items) {
      const id = str(item, list.fields.id);
      const title = str(item, list.fields.title);
      if (!id || title === null) continue;
      out.push({ id, title, state: str(item, list.fields.state), subsystem: str(item, list.fields.subsystem), author: str(item, list.fields.author) });
    }
    if (items.length < pageSize) break;
  }
  return out;
}

export function hasTitleTag(title: string, tags: string[]): boolean {
  const t = title.trim().toLowerCase();
  return tags.some((tag) => t.startsWith(tag.trim().toLowerCase()));
}

/**
 * One look. Never throws for one card's or one space's trouble: it is reported and the rest goes on.
 * Cards that could not be taken are not tried again until the card changes or a day has passed.
 */
export async function pollOnce(configPath: string, opts: CardCmdOptions = {}, now = new Date()): Promise<PollResult> {
  const env = opts.env ?? process.env;
  const dir = factoryDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const result: PollResult = { started: [], skipped: [], relayed: [], resumed: [], problems: [], errors: [], notes: [] };

  // One look at a time on this machine.
  const lock = path.join(dir, "poll.lock");
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
  } catch {
    const holder = Number(fs.readFileSync(lock, "utf8"));
    if (holder && holder !== process.pid && isAlive(holder)) {
      result.notes.push(`上一次检查（进程 ${holder}）还没有结束，这次跳过`);
      return result;
    }
    fs.writeFileSync(lock, String(process.pid));
  }

  let config: PipelineConfig | null = null;
  try {
    config = loadConfig(configPath).config;
    // 1.12: Paseo, the agents and their quota must work before anything is taken on.
    result.problems = opts.skipHealthCheck ? [] : await healthProblems(config);
    if (result.problems.length > 0) {
      result.notes.push("自检没有通过，这次不接新卡片、不转达回复");
      throw new HealthStop();
    }
    const tags = config.factory.titleTags;
    const skippedFile = path.join(dir, "skipped.json");
    const skipped = readJson<Record<string, Skipped>>(skippedFile, {});
    const { routes } = cardRoutes(env);
    let newOnes = 0;
    let listAttempts = 0;
    const listFailures: string[] = [];
    const integrations = cardIntegrations(config).filter((i) => i.list);
    if (integrations.length === 0) result.notes.push("没有配置可以列出卡片的外部系统（integrations 中的 list），只转达回复");
    for (const integration of integrations) {
      const spaces = [...new Set(routes.filter((r) => r.system.toLowerCase() === integration.name.toLowerCase() && r.projectId).map((r) => r.projectId!))];
      if (spaces.length === 0) {
        result.notes.push(`${integration.name}：本机登记的仓库都没有写空间（cardSource.projectId），不知道去哪里找卡片`);
        continue;
      }
      for (const space of spaces) {
        let cards: ListedCard[];
        listAttempts += 1;
        try {
          cards = await listCards(integration, space, tags[0], opts.run);
        } catch (error) {
          listFailures.push(`${integration.name} 空间 ${space}：${(error as Error).message}`);
          result.errors.push(`${integration.name} 空间 ${space}：${(error as Error).message}`);
          continue;
        }
        for (const card of cards.filter((c) => hasTitleTag(c.title, tags))) {
          const ref = `${integration.name}:${card.id}`;
          if (findCardEntry(integration.name, card.id, env)) continue;
          const key = hashText(`${card.title}\0${card.subsystem ?? ""}`);
          const before = skipped[ref];
          if (before && before.key === key && now.getTime() - new Date(before.at).getTime() < 24 * 3600_000) continue;
          if (newOnes >= config.factory.maxNewPerPoll) {
            result.notes.push(`这次已开始 ${newOnes} 个需求（factory.maxNewPerPoll），其余的下次再接`);
            break;
          }
          try {
            const begun = await beginFromCard({ integration, id: card.id, repoArg: null, configPath, opts: { ...opts, out: () => undefined } });
            if (begun.status === "started") {
              newOnes += 1;
              result.started.push(`${ref}「${card.title}」→ ${path.join(begun.repo, begun.featureDir)}`);
            }
            delete skipped[ref];
          } catch (error) {
            skipped[ref] = { reason: (error as Error).message, key, at: now.toISOString() };
            result.skipped.push(`${ref}「${card.title}」：${(error as Error).message}`);
          }
        }
      }
    }
    writeJson(skippedFile, skipped);
    if (listAttempts > 0 && listFailures.length === listAttempts) {
      result.problems.push(`列不出卡片，需求管理系统的命令可能不可用：${listFailures[0].slice(0, 200)}`);
    }

    try {
      await nudgeInterrupted(config, env, dir, result);
    } catch (error) {
      result.errors.push(`续跑中断的需求：${(error as Error).message}`);
    }

    try {
      const checked = await checkCards(null, opts, configPath, { skipFinished: true });
      for (const line of checked.lines) {
        if (/：没有新内容$/.test(line)) continue;
        if (/已转给需求会话/.test(line)) result.relayed.push(line);
        else result.errors.push(line);
      }
    } catch (error) {
      result.errors.push(`转达回复：${(error as Error).message}`);
    }
  } catch (error) {
    if (!(error instanceof HealthStop)) result.errors.push((error as Error).message);
  } finally {
    fs.rmSync(lock, { force: true });
  }
  if (config) await alertOnce(config, dir, result.problems, now);
  writeJson(path.join(dir, "status.json"), { lastPollAt: now.toISOString(), pid: process.pid, ...result });
  return result;
}

class HealthStop extends Error {}

/** Runs `work`, giving up after `ms` (a daemon that is not running may never answer). */
async function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}超过 ${ms / 1000} 秒没有响应`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 1.12: what keeps this machine from working on a new requirement: Paseo not reachable, an
 * agent provider not logged in, the subscription used up. Empty when all is well.
 */
export async function healthProblems(config: PipelineConfig): Promise<string[]> {
  const problems: string[] = [];
  try {
    await within(30_000, "连接 Paseo ", withRuntime(config, async (runtime, resolved) => {
      const roles: Array<[string, string]> = [
        ["builder", resolved.agents.builder.provider ?? ""],
        ["reviewer", resolved.agents.reviewer.provider ?? ""],
      ];
      const status = await runtime.providerStatus();
      for (const [role, full] of roles) {
        const provider = full.split("/")[0];
        if (!provider || !status) continue;
        const found = status.find((s) => s.provider === provider);
        if (!found || found.status !== "ready") problems.push(`${role} 用的 ${provider} ${found ? `不可用（${found.status}）` : "没有安装"}：在 Paseo 中登录它`);
      }
      // A used-up subscription matters when there is nothing else to fall back on.
      const usable = [resolved.agents.builder, ...(resolved.agents.fallback ? [resolved.agents.fallback] : [])].map((p) => (p.provider ?? "").split("/")[0]).filter(Boolean);
      const quotas = (await runtime.providerQuota([...new Set(usable)])) ?? [];
      const exhausted = (provider: string) => quotas.some((q) => q.provider === provider && q.usedPct !== null && q.usedPct >= 100);
      if (usable.length > 0 && usable.every(exhausted)) {
        const q = quotas.find((x) => x.provider === usable[0] && x.usedPct !== null && x.usedPct >= 100)!;
        problems.push(`${q.displayName} 的「${q.window}」额度已用完${q.resetsAt ? `，${new Date(q.resetsAt).toLocaleString("zh-CN", { hour12: false })} 恢复` : ""}`);
      }
    }));
  } catch (error) {
    problems.push(`连不上 Paseo（${(error as Error).message}）：确认这台机器上的 Paseo 正在运行`);
  }
  return problems;
}

/**
 * Tells people once when the self-check starts failing (or what fails changes), and once when
 * it passes again — not on every look. Through the configured notifiers (event "alert").
 */
async function alertOnce(config: PipelineConfig, dir: string, problems: string[], now: Date): Promise<void> {
  const file = path.join(dir, "health.json");
  const before = readJson<{ key: string; since: string | null }>(file, { key: "", since: null });
  const key = problems.join("\n");
  if (key === before.key) return;
  writeJson(file, { key, since: problems.length > 0 ? now.toISOString() : null });
  if (!key && !before.key) return;
  const text = problems.length > 0
    ? `接单器自检没有通过，暂停接新卡片：${problems.join("；")}`
    : `接单器自检恢复正常，继续接卡片${before.since ? `（自 ${new Date(before.since).toLocaleString("zh-CN", { hour12: false })} 起暂停）` : ""}`;
  appendLog(dir, text, now);
  if (config.notifiers.length === 0) return;
  await dispatchNotifiers(
    config.notifiers,
    {
      schema: 1,
      type: "alert",
      at: now.toISOString(),
      kitVersion: kitVersion(),
      feature: { dir: "", name: "", title: "接单器" },
      repo: "",
      branch: null,
      profile: "",
      originAgentId: null,
      text,
      details: { source: "factory", machine: os.hostname(), problems, recovered: problems.length === 0 },
      people: { audience: "team", requester: null, card: null, recipients: [] },
    },
    () => undefined,
  );
}

function appendLog(dir: string, text: string, now: Date): void {
  try {
    fs.appendFileSync(path.join(dir, "factory.log"), `[${now.toLocaleString("zh-CN", { hour12: false })}] ${text}\n`);
  } catch {
    // The log is a convenience.
  }
}

/**
 * 1.12: a pipeline on this machine still marked running whose process is gone (the machine
 * restarted, the process was killed): its chat gets the same message as the watchdog's, so
 * the chat checks and continues it. Once per process; a chat that cannot be reached is noted.
 */
async function nudgeInterrupted(config: PipelineConfig, env: NodeJS.ProcessEnv, dir: string, result: PollResult): Promise<void> {
  const file = path.join(dir, "nudged.json");
  const nudged = readJson<Record<string, number>>(file, {});
  const due: Array<{ key: string; pid: number; origin: string; featureDir: string; repo: string }> = [];
  for (const entry of readIndex(env)) {
    if (!entry.present) continue;
    const state = readState(statePath(entry.repo, entry.featureDir));
    if (!state || state.status !== "running" || isAlive(state.pid) || !state.originAgentId) continue;
    if (nudged[entry.key] === state.pid) continue;
    due.push({ key: entry.key, pid: state.pid, origin: state.originAgentId, featureDir: entry.featureDir, repo: entry.sourceRepo ?? entry.repo });
  }
  if (due.length === 0) return;
  await withRuntime(config, async (runtime) => {
    for (const d of due) {
      const commands = { repo: d.repo, featureDir: d.featureDir, configPath: null };
      try {
        await runtime.notifyAgent(d.origin, watchdogPrompt({ featureDir: d.featureDir, statusCommand: statusCommand(commands), resumeCommand: resumeCommand(commands) }));
        nudged[d.key] = d.pid;
        result.resumed.push(`${path.join(d.repo, d.featureDir)}：后台进程已退出，已请它的对话检查并继续`);
      } catch (error) {
        result.errors.push(`${path.join(d.repo, d.featureDir)} 的后台进程已退出，但没能通知它的对话：${(error as Error).message}`);
      }
    }
  });
  writeJson(file, nudged);
}

function describe(result: PollResult, now = new Date()): string[] {
  const stamp = now.toLocaleString("zh-CN", { hour12: false });
  const lines: string[] = [];
  for (const s of result.started) lines.push(`[${stamp}] 已开始：${s}`);
  for (const s of result.relayed) lines.push(`[${stamp}] ${s}`);
  for (const s of result.resumed) lines.push(`[${stamp}] 续跑：${s}`);
  for (const s of result.problems) lines.push(`[${stamp}] 自检：${s}`);
  for (const s of result.skipped) lines.push(`[${stamp}] 没能接：${s}`);
  for (const s of result.errors) lines.push(`[${stamp}] 出错：${s}`);
  for (const s of result.notes) lines.push(`[${stamp}] ${s}`);
  if (lines.length === 0) lines.push(`[${stamp}] 检查完毕，没有新卡片和新回复`);
  return lines;
}

function pidFile(env: NodeJS.ProcessEnv): string {
  return path.join(factoryDir(env), "factory.pid");
}

function runningPid(env: NodeJS.ProcessEnv): number | null {
  const pid = Number(readJson<string | number>(pidFile(env), 0));
  return pid && isAlive(pid) ? pid : null;
}

async function runLoop(configPath: string, opts: CardCmdOptions): Promise<number> {
  const env = opts.env ?? process.env;
  const out = opts.out ?? console.log;
  const other = runningPid(env);
  if (other && other !== process.pid) {
    out(`接单器已经在运行（进程 ${other}）。`);
    return 1;
  }
  writeJson(pidFile(env), process.pid);
  let stopping = false;
  let wake: (() => void) | null = null;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const minutes = loadConfig(configPath).config.factory.pollMinutes;
  out(`[${new Date().toLocaleString("zh-CN", { hour12: false })}] 接单器开始运行，每 ${minutes} 分钟检查一次（进程 ${process.pid}）`);
  try {
    while (!stopping) {
      for (const line of describe(await pollOnce(configPath, opts))) out(line);
      if (stopping) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, minutes * 60_000);
      });
    }
  } finally {
    if (runningPid(env) === process.pid) fs.rmSync(pidFile(env), { force: true });
    out(`[${new Date().toLocaleString("zh-CN", { hour12: false })}] 接单器已停止`);
  }
  return 0;
}

function startBackground(configPath: string, opts: CardCmdOptions): number {
  const env = opts.env ?? process.env;
  const out = opts.out ?? console.log;
  const pid = runningPid(env);
  if (pid) {
    out(`接单器已经在运行（进程 ${pid}）。`);
    return 0;
  }
  // Fail here, in front of the person, rather than silently in the background.
  loadConfig(configPath);
  fs.mkdirSync(factoryDir(env), { recursive: true });
  const log = path.join(factoryDir(env), "factory.log");
  const fd = fs.openSync(log, "a");
  const child = spawn(process.execPath, [...process.execArgv, path.join(ENGINE_DIR, "src", "factory.ts"), "run", "--config", configPath], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env,
    windowsHide: true,
  });
  child.unref();
  writeJson(pidFile(env), child.pid);
  out(`接单器已在后台运行（进程 ${child.pid}）。日志：${log}`);
  out("停止：req factory stop；查看：req factory status");
  return 0;
}

function stopBackground(opts: CardCmdOptions): number {
  const env = opts.env ?? process.env;
  const out = opts.out ?? console.log;
  const pid = runningPid(env);
  if (!pid) {
    out("接单器没有在运行。");
    return 0;
  }
  process.kill(pid, "SIGTERM");
  out(`已通知接单器（进程 ${pid}）停止；正在进行的检查会做完再停。`);
  return 0;
}

function status(opts: CardCmdOptions): number {
  const env = opts.env ?? process.env;
  const out = opts.out ?? console.log;
  const pid = runningPid(env);
  out(pid ? `接单器正在运行（进程 ${pid}）。` : "接单器没有在运行。");
  const last = readJson<(PollResult & { lastPollAt: string }) | null>(path.join(factoryDir(env), "status.json"), null);
  if (last) {
    out(`最近一次检查：${new Date(last.lastPollAt).toLocaleString("zh-CN", { hour12: false })}；开始 ${last.started.length} 个需求，转达 ${last.relayed.length} 条回复，${last.errors.length} 个错误。`);
    for (const p of last.problems ?? []) out(`  自检：${p}（这期间不接新卡片）`);
    for (const e of last.errors) out(`  出错：${e}`);
    for (const n of last.notes) out(`  ${n}`);
  }
  const skipped = readJson<Record<string, Skipped>>(path.join(factoryDir(env), "skipped.json"), {});
  const entries = Object.entries(skipped);
  if (entries.length > 0) {
    out("没能接的卡片（卡片修改后或一天后再试）：");
    for (const [ref, s] of entries) out(`  ${ref}：${s.reason}`);
  }
  out(`日志：${path.join(factoryDir(env), "factory.log")}`);
  return 0;
}

function service(configPath: string, opts: CardCmdOptions): number {
  const out = opts.out ?? console.log;
  const req = path.join(KIT_ROOT, "bin", "req.mjs");
  const command = `"${process.execPath}" "${req}" factory run --config "${configPath}"`;
  if (process.platform === "win32") {
    out("在 Windows 上作为计划任务运行（登录后自动启动），在管理员 PowerShell 中执行：");
    out(`  schtasks /Create /TN "req-kit 接单器" /SC ONLOGON /RL LIMITED /TR '${command.replace(/'/g, "''")}'`);
    out("立即启动：schtasks /Run /TN \"req-kit 接单器\"；停止：schtasks /End /TN \"req-kit 接单器\"");
  } else {
    out("在 Linux 上作为 systemd 用户服务运行，把下面的内容保存为 ~/.config/systemd/user/req-kit-factory.service：");
    out("");
    out("[Unit]\nDescription=req-kit 接单器\nAfter=network-online.target\n\n[Service]");
    out(`ExecStart=${command}\nRestart=on-failure\nRestartSec=60\n\n[Install]\nWantedBy=default.target`);
    out("");
    out("然后执行：systemctl --user daemon-reload && systemctl --user enable --now req-kit-factory");
    out("（希望不登录也运行：loginctl enable-linger $USER）。macOS 可以用 launchd 或直接 req factory start。");
  }
  out("Paseo daemon 需要同时在运行：接单器通过它创建需求会话。");
  return 0;
}

export async function main(argv: string[], opts: CardCmdOptions = {}): Promise<number> {
  const out = opts.out ?? console.log;
  const [command, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: { config: { type: "string" } }, allowPositionals: false, strict: false });
  const configPath = typeof values.config === "string" ? path.resolve(values.config) : defaultConfigPath(opts.env);
  try {
    switch (command) {
      case "once": {
        const result = await pollOnce(configPath, opts);
        for (const line of describe(result)) out(line);
        return result.errors.length > 0 ? 1 : 0;
      }
      case "run":
        return await runLoop(configPath, opts);
      case "start":
        return startBackground(configPath, opts);
      case "stop":
        return stopBackground(opts);
      case "status":
        return status(opts);
      case "service":
        return service(configPath, opts);
      default:
        out(USAGE);
        return command === undefined || command === "help" || command === "--help" ? 0 : 2;
    }
  } catch (error) {
    console.error(`出错了：${(error as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
