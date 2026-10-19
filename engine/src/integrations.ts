// External system integrations (1.9, ADR 0028): the requirement as a card in the team's
// requirement management system, kept in step with the pipeline.
//
// An integration is a local command line tool (e.g. an ALM's CLI) described in the machine or
// team configuration: how to create a card, how to change its state, and which state each
// pipeline event maps to. The engine fills the arguments from the requirement and the card
// fields the requester confirmed with the spec (card.json, written by /req), runs the tool
// without a shell, reads the card's id and link from its output and keeps them in the state
// file. A call that fails is kept in order and sent again before the next one, or with
// `req sync`. An integration never stops the pipeline.

import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { PipelineState } from "./state.js";

export const INTEGRATION_EVENTS = ["started", "approval", "blocked", "phase_done", "verify", "completed", "failed"] as const;
export type IntegrationEvent = (typeof INTEGRATION_EVENTS)[number];

export const INTEGRATION_EVENT_LABELS: Record<IntegrationEvent, string> = {
  started: "开始开发",
  approval: "等待确认方案",
  blocked: "等待需求方决定",
  phase_done: "研发完成，待测试",
  verify: "开始测试验证",
  completed: "完成",
  failed: "中断",
};

/** One command: its arguments, each may contain {placeholders}. */
export interface IntegrationAction {
  args: string[];
}

export interface IntegrationConfig {
  /** Shown to people, and the key under which the card is kept, e.g. "ALM". */
  name: string;
  /** The tool to run, e.g. "shenbing". Found on PATH; npm's .cmd shims on Windows are run through node. */
  command: string;
  /** Creates the card. `id` is a regular expression for the card id in its output (the first group, or a group named id); `url` likewise, optional. */
  create?: IntegrationAction & { id: string; url?: string };
  /** Changes the card's state; {status} is the mapped state. */
  status?: IntegrationAction;
  /** Card state for each pipeline event; "completed_with_issues" and "not_completed" refine "completed". */
  statusMap?: Partial<Record<IntegrationEvent | "completed_with_issues" | "not_completed", string>>;
  /**
   * Reads one card (1.10, cards as the source of a requirement): {id} is the card id. The output
   * is JSON; `fields` says where each value is, as a dot path such as "data.name".
   */
  query?: IntegrationAction & { fields: CardQueryFields };
  /** Replaces the card's description (1.10): {description} is the whole new description. */
  describe?: IntegrationAction;
  /**
   * Lists cards for the intake process (1.11): {projectId}, {page}, {pageSize} and {titleTag}
   * can be used. The output is JSON; `items` is where the list is (a dot path; by default the
   * first array found at data.list, data.records, data.items, data or the top level), `fields`
   * where each card's values are within an item.
   */
  list?: IntegrationAction & { items?: string; pageSize?: number; maxPages?: number; fields: CardListFields };
  /** Fields the requester confirms with the spec (card.json): name → what to fill in, for /req. */
  cardFields?: Record<string, string>;
  /** Values for {field.<name>} placeholders; a project's integrationDefaults[name] adds to these. */
  defaults?: Record<string, string>;
  timeoutSeconds?: number;
}

/** Where `query` finds each value in the tool's JSON output. title and body are required. */
export interface CardQueryFields {
  title: string;
  body: string;
  state?: string;
  author?: string;
  subsystem?: string;
  url?: string;
}

/** Where `list` finds each card's values within an item. id and title are required. */
export interface CardListFields {
  id: string;
  title: string;
  state?: string;
  subsystem?: string;
  author?: string;
}

/** What is known about a requirement's card, in the state file's `external[name]`. */
export interface ExternalRecord {
  id: string | null;
  url: string | null;
  /** Last state set on the card. */
  status: string | null;
  syncedAt: string | null;
  /** Calls that failed, oldest first; sent again before the next call and by `req sync`. */
  pending: Array<{ action: "create" | "status"; event: IntegrationEvent; status: string | null; at: string; attempts: number; error: string }>;
}

/** The card fields /req writes with the spec: card.json in the feature directory. */
export interface CardFile {
  title?: string;
  body?: string;
  fields?: Record<string, string>;
}

export function validateIntegrations(value: unknown): string | null {
  if (!Array.isArray(value)) return "integrations 必须是数组";
  const names = new Set<string>();
  for (const [i, raw] of value.entries()) {
    const at = `integrations[${i}]`;
    if (!raw || typeof raw !== "object") return `${at} 必须是对象`;
    const c = raw as Record<string, unknown>;
    if (typeof c.name !== "string" || !c.name.trim()) return `${at}.name 必须是名称，例如 "ALM"`;
    if (names.has(c.name)) return `${at}.name「${c.name}」重复了`;
    names.add(c.name);
    if (typeof c.command !== "string" || !c.command.trim()) return `${at}.command 必须是要运行的命令，例如 "shenbing"`;
    for (const key of ["create", "status", "query", "describe", "list"] as const) {
      const action = c[key] as Record<string, unknown> | undefined;
      if (action === undefined) continue;
      if (!action || !Array.isArray(action.args) || !action.args.every((a) => typeof a === "string")) return `${at}.${key}.args 必须是字符串数组`;
    }
    const create = c.create as Record<string, unknown> | undefined;
    if (create) {
      if (typeof create.id !== "string") return `${at}.create.id 必须是从输出中取卡片编号的正则表达式`;
      for (const k of ["id", "url"] as const) {
        if (create[k] === undefined) continue;
        try {
          new RegExp(String(create[k]));
        } catch (error) {
          return `${at}.create.${k} 不是有效的正则表达式：${(error as Error).message}`;
        }
      }
    }
    const query = c.query as Record<string, unknown> | undefined;
    if (query) {
      const fields = query.fields as Record<string, unknown> | undefined;
      if (!fields || typeof fields !== "object") return `${at}.query.fields 必须写明输出中各值的位置，例如 { "title": "data.name", "body": "data.description" }`;
      for (const k of ["title", "body"]) if (typeof fields[k] !== "string") return `${at}.query.fields.${k} 必须是输出中的位置，例如 "data.name"`;
      for (const [k, v] of Object.entries(fields)) {
        if (!["title", "body", "state", "author", "subsystem", "url"].includes(k)) return `${at}.query.fields 中的 ${k} 不认识（可用：title、body、state、author、subsystem、url）`;
        if (typeof v !== "string") return `${at}.query.fields.${k} 必须是字符串`;
      }
    }
    const list = c.list as Record<string, unknown> | undefined;
    if (list) {
      const fields = list.fields as Record<string, unknown> | undefined;
      if (!fields || typeof fields !== "object") return `${at}.list.fields 必须写明每张卡片各值的位置，例如 { "id": "globalId", "title": "name" }`;
      for (const k of ["id", "title"]) if (typeof fields[k] !== "string") return `${at}.list.fields.${k} 必须是卡片中的位置，例如 "globalId"`;
      for (const [k, v] of Object.entries(fields)) {
        if (!["id", "title", "state", "subsystem", "author"].includes(k)) return `${at}.list.fields 中的 ${k} 不认识（可用：id、title、state、subsystem、author）`;
        if (typeof v !== "string") return `${at}.list.fields.${k} 必须是字符串`;
      }
      if (list.items !== undefined && typeof list.items !== "string") return `${at}.list.items 必须是输出中列表的位置，例如 "data.list"`;
      for (const k of ["pageSize", "maxPages"]) if (list[k] !== undefined && !(Number.isInteger(list[k]) && (list[k] as number) > 0)) return `${at}.list.${k} 必须是正整数`;
    }
    if (c.statusMap !== undefined) {
      if (!c.statusMap || typeof c.statusMap !== "object") return `${at}.statusMap 必须是对象`;
      for (const [k, v] of Object.entries(c.statusMap)) {
        if (![...INTEGRATION_EVENTS, "completed_with_issues", "not_completed"].includes(k)) return `${at}.statusMap 中的 ${k} 不是流水线事件（可用：${INTEGRATION_EVENTS.join("、")}）`;
        if (typeof v !== "string") return `${at}.statusMap.${k} 必须是字符串`;
      }
      if (!c.status) return `${at} 写了 statusMap，但没有 status（改状态的命令）`;
    }
    for (const key of ["cardFields", "defaults"] as const) {
      const m = c[key];
      if (m === undefined) continue;
      if (!m || typeof m !== "object" || !Object.values(m).every((v) => typeof v === "string")) return `${at}.${key} 必须是"名称: 文字"的对象`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Running the tool

/**
 * How to run `command` without a shell. On Windows an npm-installed tool is a .cmd shim that
 * only cmd.exe can run, and cmd.exe would mangle arguments such as a Markdown body; the shim
 * names the script it runs, so run that with node instead.
 */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { file: string; prefix: string[] } {
  // 1.13: a JavaScript file is run with Node.js. Windows ignores the "#!/usr/bin/env node" line,
  // so starting it directly fails there; elsewhere this needs no execute permission either.
  if (/\.(m|c)?js$/i.test(command)) return { file: process.execPath, prefix: [command] };
  if (platform !== "win32" || /[\\/]/.test(command) && !/\.cmd$/i.test(command)) return { file: command, prefix: [] };
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const candidates = /\.(cmd|exe|bat)$/i.test(command) ? [command] : [`${command}.exe`, `${command}.cmd`];
  for (const dir of [...(/[\\/]/.test(command) ? [""] : dirs)]) {
    for (const name of candidates) {
      const full = dir ? path.join(dir, name) : name;
      if (!fs.existsSync(full)) continue;
      if (/\.exe$/i.test(full)) return { file: full, prefix: [] };
      const text = fs.readFileSync(full, "utf8");
      const script = /"%(?:~?dp0)%\\?([^"]+?\.(?:c|m)?js)"/i.exec(text)?.[1];
      if (script) return { file: process.execPath, prefix: [path.join(path.dirname(full), script)] };
    }
  }
  return { file: command, prefix: [] };
}

export interface RunResult {
  ok: boolean;
  output: string;
  error: string | null;
}

export type Runner = (command: string, args: string[], timeoutMs: number) => Promise<RunResult>;

export const runCommand: Runner = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    const { file, prefix } = resolveCommand(command);
    execFile(file, [...prefix, ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const output = `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`.trim();
      if (error) {
        const why = (error as NodeJS.ErrnoException).code === "ENOENT" ? `找不到命令 ${command}` : error.killed ? `超过 ${timeoutMs / 1000} 秒没有完成` : (stderr || error.message).trim().split("\n").slice(-2).join(" ");
        resolve({ ok: false, output, error: why });
      } else resolve({ ok: true, output, error: null });
    });
  });

// ---------------------------------------------------------------------------
// Arguments

export interface IntegrationContext {
  repo: string;
  featureDir: string;
  state: Pick<PipelineState, "branch" | "profile" | "type" | "outcome" | "external">;
  /** Project values for {field.*}, from the project's integrationDefaults. */
  projectDefaults?: Record<string, string>;
}

function readFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function readCard(repo: string, featureDir: string): CardFile {
  const raw = readFile(path.join(repo, featureDir, "card.json"));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as CardFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** The values arguments can name: {title}, {body}, {card.<field>}, {field.<name>}, {id}, {status}… */
export function placeholderValues(
  config: IntegrationConfig,
  ctx: IntegrationContext,
  extra: { status?: string | null; event?: IntegrationEvent; description?: string } = {},
): Record<string, string> {
  const spec = readFile(path.join(ctx.repo, ctx.featureDir, "spec.md")) ?? "";
  const card = readCard(ctx.repo, ctx.featureDir);
  const record = ctx.state.external?.[config.name];
  const values: Record<string, string> = {
    title: card.title ?? /^#\s+(.+)$/m.exec(spec)?.[1]?.trim() ?? path.basename(ctx.featureDir),
    body: card.body ?? spec,
    feature: path.basename(ctx.featureDir),
    featureDir: ctx.featureDir,
    repo: ctx.repo,
    branch: ctx.state.branch ?? "",
    type: ctx.state.type ?? "",
    profile: ctx.state.profile,
    outcome: ctx.state.outcome ?? "",
    id: record?.id ?? "",
    url: record?.url ?? "",
    status: extra.status ?? "",
    event: extra.event ?? "",
    description: extra.description ?? "",
  };
  for (const [k, v] of Object.entries({ ...(config.defaults ?? {}), ...(ctx.projectDefaults ?? {}) })) values[`field.${k}`] = v;
  for (const [k, v] of Object.entries(card.fields ?? {})) values[`card.${k}`] = String(v);
  // A card field the requester left out falls back to the configured default of the same name.
  for (const k of Object.keys(config.cardFields ?? {})) if (values[`card.${k}`] === undefined) values[`card.${k}`] = values[`field.${k}`] ?? "";
  return values;
}

/**
 * The arguments with placeholders filled. An argument that is only a placeholder and comes out
 * empty is dropped together with the option before it ("--priority {card.priority}" → nothing),
 * so optional fields need no special syntax. Unknown placeholders are an error.
 */
export function renderArgs(args: string[], values: Record<string, string>): string[] {
  const out: string[] = [];
  for (const arg of args) {
    const only = /^\{([\w.-]+)\}$/.exec(arg);
    const rendered = arg.replace(/\{([\w.-]+)\}/g, (_, key: string) => {
      if (!(key in values)) throw new Error(`参数 ${arg} 中的 {${key}} 没有对应的值`);
      return values[key];
    });
    if (only && rendered === "") {
      if (out.length > 0 && out.at(-1)!.startsWith("-")) out.pop();
      continue;
    }
    out.push(rendered);
  }
  return out;
}

function capture(pattern: string | undefined, output: string): string | null {
  if (!pattern) return null;
  const m = new RegExp(pattern).exec(output);
  if (!m) return null;
  return (m.groups?.id ?? m.groups?.url ?? m[1] ?? m[0]).trim();
}

/** The state an event sets, if any. */
export function statusFor(config: IntegrationConfig, event: IntegrationEvent, outcome: string | null): string | null {
  const map = config.statusMap ?? {};
  if (event === "completed" && (outcome === "completed_with_issues" || outcome === "not_completed") && map[outcome]) return map[outcome] ?? null;
  return map[event] ?? null;
}

/** The card a requirement started from (source.json, 1.10), as far as integrations need it. */
export function readSourceCard(repo: string, featureDir: string): { system: string; id: string; url: string | null } | null {
  const raw = readFile(path.join(repo, featureDir, "source.json"));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { system?: unknown; id?: unknown; url?: unknown };
    if (typeof parsed.system !== "string" || typeof parsed.id !== "string") return null;
    return { system: parsed.system, id: parsed.id, url: typeof parsed.url === "string" ? parsed.url : null };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Syncing

function emptyRecord(): ExternalRecord {
  return { id: null, url: null, status: null, syncedAt: null, pending: [] };
}

/**
 * Brings one integration up to date for an event: sends what failed before (in order), creates
 * the card if there is none yet, then sets the event's state. Updates `state.external` in place;
 * the caller saves the state. Returns lines for the log. Never throws.
 */
export async function syncIntegration(input: {
  config: IntegrationConfig;
  ctx: IntegrationContext & { state: PipelineState };
  event: IntegrationEvent | null;
  run?: Runner;
  log: (message: string) => void;
}): Promise<ExternalRecord> {
  const { config, ctx, log } = input;
  const run = input.run ?? runCommand;
  const timeout = (config.timeoutSeconds ?? 60) * 1000;
  ctx.state.external ??= {};
  const record = (ctx.state.external[config.name] ??= emptyRecord());
  const now = () => new Date().toISOString();
  // A requirement that started from a card in this system (1.10) uses that card, never a new one.
  if (!record.id) {
    const source = readSourceCard(ctx.repo, ctx.featureDir);
    if (source && source.system === config.name) {
      record.id = source.id;
      record.url = source.url;
      record.pending = record.pending.filter((p) => p.action !== "create");
    }
  }

  const attempt = async (action: "create" | "status", event: IntegrationEvent, status: string | null): Promise<boolean> => {
    const def = action === "create" ? config.create : config.status;
    if (!def) return true;
    let args: string[];
    try {
      args = renderArgs(def.args, placeholderValues(config, ctx, { status, event }));
    } catch (error) {
      log(`${config.name}：${(error as Error).message}，没有调用`);
      return false;
    }
    const result = await run(config.command, args, timeout);
    if (!result.ok) {
      log(`${config.name}：${action === "create" ? "建卡" : `改为「${status}」`}失败：${result.error}`);
      const prev = record.pending.find((p) => p.action === action && p.status === status);
      if (prev) {
        prev.attempts += 1;
        prev.error = result.error ?? "";
      } else {
        if (action === "status") record.pending = record.pending.filter((p) => p.action !== "status");
        record.pending.push({ action, event, status, at: now(), attempts: 1, error: result.error ?? "" });
      }
      return false;
    }
    if (action === "create") {
      const id = capture(config.create!.id, result.output);
      if (!id) {
        log(`${config.name}：建卡命令成功了，但输出中没有找到卡片编号（create.id 的正则没有匹配）。输出：${result.output.slice(0, 300)}`);
        record.pending.push({ action, event, status, at: now(), attempts: 1, error: "输出中没有卡片编号" });
        return false;
      }
      record.id = id;
      record.url = capture(config.create!.url, result.output);
      log(`${config.name}：已建卡 ${id}${record.url ? `（${record.url}）` : ""}`);
    } else {
      record.status = status;
      log(`${config.name}：${record.id} 已改为「${status}」`);
    }
    record.syncedAt = now();
    record.pending = record.pending.filter((p) => !(p.action === action && (action === "create" || p.status === status)));
    return true;
  };

  try {
    // A new state replaces one still waiting to be sent: only the latest matters.
    const newStatus = input.event ? statusFor(config, input.event, ctx.state.outcome ?? null) : null;
    if (newStatus) record.pending = record.pending.filter((p) => p.action !== "status");
    // 1. What failed before, oldest first; stop at the first that still fails, keeping the order.
    let blocked = false;
    for (const p of [...record.pending]) {
      if (p.action === "status" && !record.id) {
        blocked = true;
        break;
      }
      if ((p.action === "status" && p.status === record.status) || (p.action === "create" && record.id)) {
        record.pending = record.pending.filter((x) => x !== p);
        continue;
      }
      const index = record.pending.indexOf(p);
      record.pending.splice(index, 1);
      if (!(await attempt(p.action, p.event, p.status))) {
        // attempt() appended it again; put it back where it was so the order holds.
        const again = record.pending.pop();
        if (again) record.pending.splice(index, 0, { ...again, attempts: p.attempts + 1, at: p.at });
        blocked = true;
        break;
      }
    }
    if (!input.event) return record;
    // 2. A card for this requirement.
    if (!record.id && config.create && !blocked) {
      if (!(await attempt("create", input.event, null))) blocked = true;
    }
    // 3. The event's state: now, or queued behind what is still waiting.
    const status = newStatus;
    if (status && status !== record.status && !record.pending.some((p) => p.action === "status" && p.status === status)) {
      // Only the latest state matters: a state still waiting is replaced, not sent after this one.
      if (blocked || !record.id) {
        record.pending = record.pending.filter((p) => p.action !== "status");
        record.pending.push({ action: "status", event: input.event, status, at: now(), attempts: 0, error: "等待前面的调用完成" });
      }
      else await attempt("status", input.event, status);
    }
  } catch (error) {
    log(`${config.name}：${(error as Error).message}`);
  }
  return record;
}

/** Plain-language summary lines for status and reports. */
export function describeExternal(external: PipelineState["external"]): string[] {
  const lines: string[] = [];
  for (const [name, r] of Object.entries(external ?? {})) {
    const head = r.id ? `${name}：${r.id}${r.url ? `（${r.url}）` : ""}${r.status ? `，状态「${r.status}」` : ""}` : `${name}：还没有建卡`;
    lines.push(r.pending.length > 0 ? `${head}；有 ${r.pending.length} 次调用没有成功，下次自动补发（或 req sync）：${r.pending.at(-1)!.error}` : head);
  }
  return lines;
}

/** For `--card-fields`: what /req should ask for and write to card.json, or null without integrations. */
export function cardFieldsText(integrations: IntegrationConfig[]): string | null {
  const withFields = integrations.filter((i) => i.cardFields && Object.keys(i.cardFields).length > 0);
  if (withFields.length === 0) return null;
  const lines = [
    "需求说明确认时，一并和需求方确认下面的卡片字段，写入功能目录的 card.json（和 spec.md 一起提交）：",
    '{ "title": "<卡片标题，默认用需求说明的标题>", "fields": { "<字段>": "<值>", … } }',
    "",
  ];
  for (const i of withFields) {
    lines.push(`${i.name}：`);
    for (const [k, v] of Object.entries(i.cardFields!)) lines.push(`- ${k}：${v}${i.defaults?.[k] ? `（默认 ${i.defaults[k]}）` : ""}`);
  }
  lines.push("", "能从需求说明中判断的直接填上请需求方确认；判断不了的问需求方；不知道的可以不写（用默认值或不填）。");
  return lines.join("\n");
}

/** Checks that the tool can be found, for the doctor. */
export function commandAvailable(command: string): boolean {
  const { file, prefix } = resolveCommand(command);
  const r = spawnSync(file, [...prefix, "--help"], { encoding: "utf8", timeout: 20_000, windowsHide: true });
  return !r.error;
}
