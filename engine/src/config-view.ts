// The whole req-kit configuration as people read it (1.12, `req api config`, the plugin's
// settings view): every setting with a plain name, what it does, its value in words, and which
// file set it (default, this machine, the team, the project). Secrets are never shown.

import fs from "node:fs";
import path from "node:path";
import {
  type AgentProfile,
  DEFAULT_CONFIG,
  loadConfig,
  MACHINE_ONLY_KEYS,
  NOT_IN_PROJECT_KEYS,
  PHASE_MODE_LABELS,
  type PipelineConfig,
  PROFILE_LABELS,
  PROJECT_CONFIG_FILE,
} from "./config.js";
import { describeAgentProfile } from "./paseo-profiles.js";
import { STEPS, type StepId } from "./steps.js";

export type Layer = "default" | "machine" | "team" | "project";

export const LAYER_LABELS: Record<Layer, string> = { default: "默认", machine: "本机", team: "团队", project: "项目" };

export interface ConfigItem {
  key: string;
  label: string;
  description: string;
  /** The value in words. */
  display: string;
  /** The value itself, secrets masked. */
  value: unknown;
  /** The files that set it, in the order they apply; empty when it is the default. */
  setBy: Exclude<Layer, "default">[];
  /** Where it may be set: machine-only settings are ignored in team and project files. */
  scope: "any" | "machine" | "machine_team";
  /** Whether the value differs from req-kit's default (a file may repeat the default). */
  changed: boolean;
}

export interface ConfigGroup {
  id: string;
  title: string;
  description: string;
  items: ConfigItem[];
}

export interface ConfigView {
  sources: Array<{ layer: Exclude<Layer, "default">; path: string }>;
  /** Settings a team or project file may not set, which were left out. */
  ignored: string[];
  /** The configuration does not load; the values shown are the files' as written. */
  error: string | null;
  repo: string | null;
  groups: ConfigGroup[];
}

const onOff = (v: unknown) => (v ? "开" : "关");
const minutes = (v: unknown) => (Number(v) > 0 ? `${v} 分钟` : "关闭");
const hours = (v: unknown) => (Number(v) > 0 ? `${v} 小时` : "关闭");
const list = (v: unknown) => (Array.isArray(v) && v.length > 0 ? v.join("、") : "无");
const profilesText = (v: unknown) => (Array.isArray(v) ? v.map((p) => PROFILE_LABELS[p as "quick"] ?? p).join("、") + "档" : String(v));

function agent(p: AgentProfile | null | undefined): string {
  return p ? describeAgentProfile(p) : "未设置";
}

interface Entry {
  label: string;
  description: string;
  display?: (value: unknown, config: PipelineConfig) => string;
}

/** Groups in the order people look for them; a key not listed here goes to "其他". */
const CATALOG: Array<{ id: string; title: string; description: string; keys: Record<string, Entry> }> = [
  {
    id: "agents",
    title: "模型与评审",
    description: "谁来写代码、谁来评审，以及评审有多严格。",
    keys: {
      agents: {
        label: "agent",
        description: "builder 做方案、写代码和修复；reviewer 审方案、评审代码和验证；备用模型在主模型一直失败时接手一步。",
        display: (v) => {
          const a = v as PipelineConfig["agents"];
          return `builder：${agent(a.builder)}；reviewer：${agent(a.reviewer)}；备用模型：${a.fallback ? agent(a.fallback) : "不用"}`;
        },
      },
      defaultProfile: { label: "默认档位", description: "需求说明没写档位时用哪个。", display: (v) => `${PROFILE_LABELS[v as "quick"] ?? v}档` },
      profiles: {
        label: "各档位的轮数",
        description: "方案审核、代码评审、缺陷修复最多几轮，以及是否先验证服务能启动。",
        display: (v) =>
          Object.entries(v as PipelineConfig["profiles"])
            .map(([name, p]) => `${PROFILE_LABELS[name as "quick"] ?? name}档：方案审核 ${p.rounds.designReview} 轮、代码评审 ${p.rounds.codeReview} 轮、缺陷修复 ${p.rounds.defectFix} 轮${p.serviceStart ? "、验证服务启动" : ""}`)
            .join("；"),
      },
      reviewAxes: { label: "分方向评审", description: "代码评审分“规格”和“规范”两个方向各看一遍。", display: (v) => { const r = v as PipelineConfig["reviewAxes"]; return r.enabled ? `开（${profilesText(r.profiles)}）` : "关"; } },
      reviewPanel: { label: "评审小组", description: "几个模型同时评审，再汇总。", display: (v) => { const r = v as PipelineConfig["reviewPanel"]; return r.enabled ? `${r.members.length} 位成员，用于${r.steps.map((s) => STEPS[s as StepId]?.title ?? s).join("、")}（${profilesText(r.profiles)}）` : "关"; } },
      designProposals: { label: "方案提案", description: "方案设计前先让几个模型各出一份提案。", display: (v) => { const r = v as PipelineConfig["designProposals"]; return r.enabled ? `开（${profilesText(r.profiles)}${r.members.length ? `，${r.members.length} 位成员` : ""}）` : "关"; } },
    },
  },
  {
    id: "flow",
    title: "流程",
    description: "需求按什么顺序走、在哪里停下等人。",
    keys: {
      phases: {
        label: "执行方式",
        description: "研发完成后接着测试验证，还是停下等测试，或只做研发。",
        display: (v) => { const p = v as PipelineConfig["phases"]; return `${PHASE_MODE_LABELS[p.mode]}；测试验证在${p.verify.environment === "deployed" ? "已部署的测试环境" : "本地"}；发现缺陷时${p.verify.defects === "fix" ? "直接修复" : p.verify.defects === "handback" ? "退回研发阶段" : "只记录"}`; },
      },
      designApproval: { label: "方案确认点", description: "写代码前请需求方确认“做完后会看到什么”。", display: (v) => { const d = v as PipelineConfig["designApproval"]; return d.mode === "off" ? "关" : `${d.mode === "always" ? "总是" : "有界面改动时"}（${profilesText(d.profiles)}）${d.autoContinueHours > 0 ? `，${d.autoContinueHours} 小时没回应按方案继续` : "，一直等确认"}`; } },
      specReview: { label: "需求说明审阅", description: "开发前由另一个模型审一遍需求说明。", display: (v) => ({ off: "关", standard: "标准档", always: "所有档位" })[String(v)] ?? String(v) },
      requirementTypes: { label: "按类型的做法", description: "缺陷、重构、评估各走自己的做法。", display: (v) => list((v as string[]).map((t) => ({ defect: "缺陷", refactor: "重构", assessment: "评估" })[t] ?? t)) },
      slices: { label: "按切片实现", description: "方案分几片时逐片实现。", display: (v) => { const s = v as PipelineConfig["slices"]; return `${profilesText(s.profiles)}，最多 ${s.max} 片`; } },
      browserVerify: { label: "检查网页界面", description: "功能验证时用界面检查命令（不靠看图）检查网页；Paseo 有内置浏览器时也用它操作。", display: (v) => ({ auto: "自动", off: "关" })[String(v)] ?? String(v) },
      paseoServices: { label: "由 Paseo 启动服务", description: "用 paseo.json 中的服务脚本启动和重启服务。", display: (v) => ({ auto: "自动", off: "关" })[String(v)] ?? String(v) },
      serviceReadySeconds: { label: "等服务就绪", description: "启动服务后最多等多久。", display: (v) => `${v} 秒` },
      budget: {
        label: "每个需求的 token 预算",
        description: "一个需求所有步骤合计（输入 + 输出）最多用多少 tokens；用到一定比例时提醒，用完后做完当前步骤就停下，继续开发会再给一份预算。",
        display: (v) => { const b = v as PipelineConfig["budget"]; return b.tokens === null ? "不限" : `${b.tokens >= 10_000 ? `${Math.round(b.tokens / 1000) / 10} 万` : b.tokens}，用到 ${b.warnPercent}% 时提醒`; },
      },
      scanGuard: {
        label: "打断大目录搜索",
        description: "步骤 agent 搜索整个磁盘、用户目录、Maven 仓库（.m2）、全局 node_modules 等很大的目录时，一分钟后打断它并告诉它该怎么查；任何搜索运行太久也打断。",
        display: (v) => { const g = v as PipelineConfig["scanGuard"]; return g.enabled ? `开，搜索超过 ${g.minutes} 分钟也打断${g.paths.length ? `；另外不许整个搜索：${g.paths.join("、")}` : ""}` : "关"; },
      },
      dangerGuard: {
        label: "拦截危险命令",
        description: "步骤 agent 推送代码、发布制品、改动集群、连接其他机器上的数据库或主机、删除仓库以外的目录、下载脚本直接执行，或命令里出现生产环境的地址时，打断它并通知你。",
        display: (v) => { const g = v as PipelineConfig["dangerGuard"]; return g.enabled ? `开${g.production.length ? `；生产环境标记 ${g.production.length} 个` : ""}${g.allow.length ? `；放行 ${g.allow.length} 条` : ""}` : "关"; },
      },
      secretScan: {
        label: "密钥扫描",
        description: "每次改代码的步骤之后、推送分支之前，检查本需求新增的内容里有没有密钥、令牌、口令；发现了让 agent 去掉，去不掉就不推送。",
        display: (v) => { const g = v as PipelineConfig["secretScan"]; return g.enabled ? `开${g.allow.length ? `；不扫描：${g.allow.join("、")}` : ""}` : "关"; },
      },
    },
  },
  {
    id: "quality",
    title: "质量",
    description: "流水线自己运行的检查，以及可以参考的其他仓库。",
    keys: {
      checks: { label: "质量门的检查", description: "写代码和修复后，流水线自己运行这些命令，比较改动前后。通常由 /req-setup 写在项目配置中。", display: (v) => (Array.isArray(v) && v.length > 0 ? (v as Array<{ name: string; command: string }>).map((c) => `${c.name}（${c.command}）`).join("、") : "没有（不运行质量门）") },
      qualityGate: { label: "质量门的修复", description: "检查发现新失败时，同一个 agent 修几次；每项检查的时限。", display: (v) => { const q = v as PipelineConfig["qualityGate"]; return `最多修 ${q.fixAttempts} 次，每项 ${q.timeoutMinutes} 分钟`; } },
      relatedRepos: { label: "关联仓库", description: "步骤 agent 可以读、不会修改的其他仓库（例如前端项目的后端）。", display: (v) => (Array.isArray(v) && v.length > 0 ? (v as Array<{ name: string; path: string }>).map((r) => `${r.name}（${r.path}）`).join("、") : "无") },
    },
  },
  {
    id: "automation",
    title: "自动处理与时限",
    description: "出了问题时流水线自己怎么处理，什么时候才停下等人。",
    keys: {
      selfHeal: { label: "自愈", description: "超时时 agent 还在做就多等一轮；agent 报错、结果文件无效时新开 agent 重做一次。", display: onOff },
      answerQuestionsFirst: { label: "方案审核的问题先自答", description: "审核要需求方决定的问题，先由 builder 从代码和文档中找答案。", display: onOff },
      retry: { label: "临时错误重试", description: "限流、网络中断时换一个 agent 重做这一步。", display: (v) => { const r = v as PipelineConfig["retry"]; return r.attempts > 0 ? `${r.attempts} 次，分别等 ${r.backoffSeconds.join("、")} 秒` : "关"; } },
      autoResumeMinutes: { label: "自动继续", description: "临时错误中断后，多久自动继续（限流时按额度恢复时间）。", display: minutes },
      autoResumeMax: { label: "自动继续的次数", description: "每次尝试最多自动继续几次。", display: (v) => `${v} 次` },
      watchdogMinutes: { label: "定时检查", description: "运行期间定时检查，后台进程意外退出时自动继续。", display: (v) => (Number(v) > 0 ? `每 ${v} 分钟` : "关闭") },
      stepTimeoutMinutes: {
        label: "各步骤的时限",
        description: "超过时限仍未完成就中断（打开自愈时先多等一轮）。",
        display: (v) =>
          Object.entries(v as Record<string, number>)
            .filter(([id]) => STEPS[id as StepId])
            .map(([id, m]) => `${STEPS[id as StepId].title} ${m} 分钟`)
            .join("、"),
      },
      resultFollowUps: { label: "提醒补写结果", description: "结果文件缺失或格式不对时，提醒 agent 几次。", display: (v) => `${v} 次` },
      quotaWarnPercent: { label: "额度提醒", description: "开始时额度用到这么多就提醒。", display: (v) => (Number(v) > 0 ? `${v}%` : "关闭") },
      waitingReminderHours: { label: "等待提醒", description: "等需求方回答或等测试超过这么久，提醒一次。", display: hours },
      maxConcurrentPipelines: { label: "同时运行的上限", description: "本机同时运行的流水线数，满了排队。", display: (v) => (Number(v) > 0 ? `${v} 个` : "不限") },
      queuePollSeconds: { label: "排队检查间隔", description: "排队时多久看一次有没有空位。", display: (v) => `${v} 秒` },
    },
  },
  {
    id: "cards",
    title: "卡片与接单器",
    description: "和需求管理系统的对接、从卡片开始的需求，以及共享机器上的接单器。",
    keys: {
      integrations: { label: "对接的外部系统", description: "用命令读写需求管理系统中的卡片。", display: (v) => (Array.isArray(v) && v.length > 0 ? (v as Array<{ name: string; command: string } & Record<string, unknown>>).map((i) => `${i.name}（${i.command}；${["create", "status", "query", "describe", "list"].filter((k) => i[k]).join("、")}）`).join("；") : "无") },
      integrationDefaults: { label: "对接字段的默认值", description: "按系统填卡片字段的固定值（例如项目编号）。", display: (v) => { const n = Object.keys(v as object).length; return n > 0 ? `${n} 个系统` : "无"; } },
      cardSource: { label: "这个仓库接哪些卡片", description: "系统、空间和子系统，由 /req-setup 写在项目配置中。", display: (v) => { if (!v) return "未设置"; const c = v as NonNullable<PipelineConfig["cardSource"]>; return `${c.system}${c.projectId ? ` 空间 ${c.projectId}` : ""}；子系统 ${list(c.subsystems)}${c.titleKeywords.length ? `；标题关键字 ${list(c.titleKeywords)}` : ""}`; } },
      push: { label: "推送分支", description: "从卡片开始的需求研发完成后，推送到 req/ 前缀的分支（可以再建草稿合并请求）。不强推、不合并。", display: (v) => { const p = v as PipelineConfig["push"]; return p.enabled ? `推送到 ${p.remote}/${p.branchPrefix}<卡号>${p.mergeRequest ? `，用 ${p.mergeRequest.command} 建草稿合并请求` : ""}` : "关"; } },
      factory: { label: "接单器", description: "多久检查一次、认哪些标题标识、每次最多接几张。", display: (v) => { const f = v as PipelineConfig["factory"]; return `每 ${f.pollMinutes} 分钟；标识 ${list(f.titleTags)}；每次最多 ${f.maxNewPerPoll} 个`; } },
      autoConfirm: { label: "小改动自动确认", description: "快速档、没有待答问题的卡片，过这么久没有异议就开始。", display: (v) => hours((v as PipelineConfig["autoConfirm"]).hours) },
    },
  },
  {
    id: "notify",
    title: "通知",
    description: "进展和需要人的事发到哪里、发给谁。",
    keys: {
      notifyMilestones: { label: "进展通知", description: "方案定了、开始验证等关键点在对话里说一句。", display: onOff },
      notifiers: { label: "外部通知", description: "额外调用的通知模块（例如内部 IM）。", display: (v) => (Array.isArray(v) && v.length > 0 ? (v as Array<{ module: string; events?: string[] }>).map((n) => `${path.basename(n.module)}（${n.events ? n.events.join("、") : "全部事件"}）`).join("；") : "无") },
      people: { label: "按人通知的账号", description: "需求方姓名对应的 IM 账号，通知模块按人发送时用。", display: (v) => { const n = Object.keys(v as object).length; return n > 0 ? `${n} 人` : "无"; } },
    },
  },
  {
    id: "machine",
    title: "连接与运行",
    description: "这台机器怎么连 Paseo，以及步骤 agent 怎么创建。",
    keys: {
      daemonUrl: { label: "Paseo 地址", description: "本机 Paseo daemon 的地址。" },
      daemonPasswordEnv: { label: "Paseo 密码的环境变量", description: "daemon 设置了密码时，从这个环境变量读取（这里只显示变量名）。" },
      teamConfig: { label: "团队配置", description: "团队共用的配置文件。", display: (v) => (v ? String(v) : "未使用") },
      requiredVersion: { label: "版本要求", description: "团队或项目要求的 req-kit 版本范围。", display: (v) => (v ? String(v) : "无") },
      attachToOriginChat: { label: "步骤挂在发起的对话下", description: "步骤 agent 作为子 agent 显示在发起的对话中。", display: onOff },
      archiveStepAgents: { label: "完成后归档步骤", description: "步骤完成后把它的 agent 归档。", display: onOff },
      waitChunkSeconds: { label: "等待分段", description: "等待 agent 时每段的长度。", display: (v) => `${v} 秒` },
      permissionPollSeconds: { label: "权限检查间隔", description: "agent 等待批准时多久看一次。", display: (v) => `${v} 秒` },
    },
  },
];

const SECRET = /token|password|passwd|secret|webhook|api[_-]?key|authorization|cookie/i;

/** The value with anything that looks like a secret, and people's accounts, replaced. */
export function masked(value: unknown, key = ""): unknown {
  if (key === "people" && value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as object).map((name) => [name, "••••"]));
  }
  if (Array.isArray(value)) return value.map((v) => masked(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET.test(k) && typeof v === "string" ? "••••" : masked(v, k)]));
  }
  return value;
}

function readRaw(file: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function plain(value: unknown): string {
  if (value === null || value === undefined) return "未设置";
  if (typeof value === "boolean") return onOff(value);
  if (typeof value === "string" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/** The configuration that applies in `repo` (or on this machine, outside any project). */
export function configView(configPath: string, repo: string | null): ConfigView {
  const layers: Array<{ layer: Exclude<Layer, "default">; path: string; raw: Record<string, unknown> }> = [];
  const machine = readRaw(configPath);
  if (machine) layers.push({ layer: "machine", path: configPath, raw: machine });
  if (machine && typeof machine.teamConfig === "string" && machine.teamConfig) {
    const teamFile = path.resolve(path.dirname(configPath), machine.teamConfig);
    const team = readRaw(teamFile);
    if (team) layers.push({ layer: "team", path: teamFile, raw: team });
  }
  if (repo) {
    const projectFile = path.join(repo, PROJECT_CONFIG_FILE);
    const project = readRaw(projectFile);
    if (project) layers.push({ layer: "project", path: projectFile, raw: project });
  }

  let config: PipelineConfig;
  let error: string | null = null;
  let ignored: string[] = [];
  try {
    const loaded = loadConfig(configPath, repo ?? undefined);
    config = loaded.config;
    ignored = loaded.ignored;
  } catch (e) {
    error = (e as Error).message;
    config = { ...DEFAULT_CONFIG, ...Object.assign({}, ...layers.map((l) => l.raw)) } as PipelineConfig;
  }

  const allowed = (layer: Exclude<Layer, "default">, key: string) =>
    layer === "machine" || (!(MACHINE_ONLY_KEYS as readonly string[]).includes(key) && !(layer === "project" && (NOT_IN_PROJECT_KEYS as readonly string[]).includes(key)));
  const scopeOf = (key: string): ConfigItem["scope"] =>
    (MACHINE_ONLY_KEYS as readonly string[]).includes(key) ? "machine" : (NOT_IN_PROJECT_KEYS as readonly string[]).includes(key) ? "machine_team" : "any";

  const listed = new Set<string>();
  const item = (key: string, entry: Entry): ConfigItem => {
    listed.add(key);
    const value = (config as unknown as Record<string, unknown>)[key];
    let display: string;
    try {
      display = entry.display ? entry.display(value, config) : plain(value);
    } catch {
      display = plain(value);
    }
    return {
      key,
      label: entry.label,
      description: entry.description,
      display,
      value: masked(value, key),
      setBy: layers.filter((l) => key in l.raw && allowed(l.layer, key)).map((l) => l.layer),
      scope: scopeOf(key),
      changed: JSON.stringify(value) !== JSON.stringify((DEFAULT_CONFIG as unknown as Record<string, unknown>)[key]),
    };
  };
  const groups: ConfigGroup[] = CATALOG.map((g) => ({ id: g.id, title: g.title, description: g.description, items: Object.entries(g.keys).map(([k, e]) => item(k, e)) }));
  const rest = Object.keys(config).filter((k) => !listed.has(k));
  if (rest.length > 0) {
    groups.push({ id: "other", title: "其他", description: "上面没有归类的设置。", items: rest.map((k) => item(k, { label: k, description: "" })) });
  }
  return { sources: layers.map(({ layer, path: p }) => ({ layer, path: p })), ignored, error, repo, groups };
}
