// req-kit doctor: read-only health check, run by the /req-doctor skill.
//
//   node bin/req-doctor.mjs [--repo <dir>] [--no-project] [--offline] [--config <file>]
//
// Sections: installation (delegated to install.mjs --check), configuration,
// Paseo daemon, and the current project with its pipelines.

import { execFileSync, spawnSync } from "node:child_process";
import { type PaseoJson, windowsPaseoJsonIssues } from "./paseo-json.js";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, DEFAULT_CONFIG, loadConfig, type PipelineConfig, PROJECT_CONFIG_FILE } from "./config.js";
import { checkProfile, connect, type Report, satisfies } from "./daemon-check.js";
import { daemonVersion } from "./daemon-version.js";
import { gitInfo } from "./git.js";
import { defaultConfigPath, findDependency, KIT_ROOT, kitVersion } from "./locations.js";
import { PROJECT_DIR } from "./prompts.js";
import { describeAgentProfile, ProfileResolutionError, profilesFromDaemonConfig, resolveConfigProfiles, usesPaseoProfiles } from "./paseo-profiles.js";
import { isAlive, STATE_VERSION } from "./state.js";

const counts = { fail: 0, warn: 0 };
const SYMBOL = { ok: "✓", warn: "⚠", fail: "✗" } as const;

const report: Report = (level, text, fix) => {
  if (level !== "ok") counts[level] += 1;
  console.log(`${SYMBOL[level]} ${text}`);
  if (fix) console.log(`    修复：${fix}`);
};

function section(title: string): void {
  console.log(`\n## ${title}\n`);
}

/** Newer published version, as an informational line; never counted as a problem. */
function newVersion(): void {
  const result = spawnSync(process.execPath, [path.join(KIT_ROOT, "install.mjs"), "--latest", "--quiet"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });
  const latest = result.status === 0 ? result.stdout.trim().split("\n")[0] : "";
  const current = kitVersion();
  if (!latest) {
    console.log(`· 无法检查是否有新版本（${(result.stderr ?? "").trim().split("\n").at(-1) || "网络不通或超时"}），不影响使用`);
  } else if (latest !== current && newer(latest, current)) {
    console.log(`↑ 有新版本 ${latest}（当前 ${current}）。升级：req upgrade（或在安装目录运行 node install.mjs --upgrade）`);
  } else {
    report("ok", `已是最新版本 ${current}`);
  }
}

/** a > b in semver order (prereleases before their release). */
function newer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v);
    return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i];
  if (pa.pre === pb.pre) return false;
  if (pa.pre === null) return true;
  if (pb.pre === null) return false;
  return pa.pre.localeCompare(pb.pre, "en", { numeric: true }) > 0;
}

function installation(offline: boolean): void {
  section("安装");
  const result = spawnSync(process.execPath, [path.join(KIT_ROOT, "install.mjs"), "--check", "--quiet"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd();
  for (const line of out.split("\n")) {
    if (line.startsWith("✗")) counts.fail += 1;
    else if (line.startsWith("⚠")) counts.warn += 1;
    if (line.trim()) console.log(line);
  }
  const pkg = path.join(findDependency("@getpaseo/client") ?? path.join(KIT_ROOT, "node_modules", "@getpaseo", "client"), "package.json");
  const range = readPaseoRange();
  if (fs.existsSync(pkg) && range) {
    const sdk = (JSON.parse(fs.readFileSync(pkg, "utf8")) as { version: string }).version;
    if (satisfies(sdk, range)) report("ok", `Paseo SDK ${sdk}（本版本支持 ${range}）`);
    else report("warn", `Paseo SDK ${sdk} 不在本版本支持的范围 ${range} 内`, "确认 Paseo 与 req-kit 版本匹配，必要时升级 req-kit");
  }
  if (!offline) newVersion();
}

function readPaseoRange(): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, "package.json"), "utf8")) as { reqKit?: { paseo?: string } };
    return pkg.reqKit?.paseo ?? null;
  } catch {
    return null;
  }
}

function configuration(configPath: string, repo: string | null): PipelineConfig | null {
  section("配置");
  if (!fs.existsSync(configPath)) {
    report("fail", `找不到本机配置 ${configPath}`, "在 req-kit 安装目录运行 node install.mjs 生成，或用 node install.mjs --import-legacy <旧安装目录> 导入旧配置");
    return null;
  }
  try {
    const loaded = loadConfig(configPath, repo ?? undefined);
    report("ok", `配置：${loaded.sources.join(" → ")}`);
    if (loaded.ignored.length > 0) {
      report("warn", `${loaded.ignored.join("、")} 只能在本机配置中设置，已被忽略`, "从团队或项目配置中删除这些字段");
    }
    const { builder, reviewer } = loaded.config.agents;
    report("ok", `builder：${describeAgentProfile(builder)}；reviewer：${describeAgentProfile(reviewer)}`);
    report("ok", `默认档位：${loaded.config.defaultProfile}`);
    const panel = loaded.config.reviewPanel;
    if (panel.enabled) {
      report("ok", `评审小组：${panel.members.length} 位成员，用于 ${panel.steps.join("、")}（${panel.profiles.join("、")}档，首轮）`);
      if (panel.members.length === 1) report("warn", "评审小组只有 1 位成员，效果接近单人评审", "建议配置 2–3 位，使用不同厂商的模型");
    }
    const proposals = loaded.config.designProposals;
    if (proposals.enabled) {
      report("ok", `方案提案：${proposals.members.length || "builder 和 reviewer 各"} ${proposals.members.length ? "位成员" : "一份"}，用于 ${proposals.profiles.join("、")}档`);
    }
    const required = loaded.config.requiredVersion;
    if (required) {
      if (satisfies(kitVersion(), required)) report("ok", `版本要求 ${required}：当前 ${kitVersion()} 满足`);
      else report("warn", `团队或项目要求 req-kit ${required}，当前为 ${kitVersion()}`, "按 docs/guide/安装与升级.md 升级到符合要求的版本");
    }
    return loaded.config;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    report("fail", error.message, `编辑 ${configPath}`);
    return null;
  }
}

/** Daemon address from the raw file, so the daemon can be checked even when the agents are not filled in yet. */
function daemonSettings(configPath: string): PipelineConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<PipelineConfig>;
    return { ...DEFAULT_CONFIG, ...(raw.daemonUrl ? { daemonUrl: raw.daemonUrl } : {}), ...(raw.daemonPasswordEnv ? { daemonPasswordEnv: raw.daemonPasswordEnv } : {}) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** Informational line: never counted as a problem. */
function info(text: string): void {
  console.log(`· ${text}`);
}

async function daemon(config: PipelineConfig | null, configPath: string): Promise<void> {
  section("Paseo daemon");
  const settings = config ?? daemonSettings(configPath);
  let client;
  try {
    client = await connect(settings);
  } catch (error) {
    report(
      "fail",
      `无法连接 daemon ${settings.daemonUrl}：${(error as Error).message}`,
      `确认 Paseo 桌面端或 daemon 正在运行；设置了密码时，确认环境变量 ${settings.daemonPasswordEnv} 已设置`,
    );
    return;
  }
  try {
    report("ok", `已连接 ${settings.daemonUrl}`);
    const range = readPaseoRange();
    const version = await daemonVersion(settings.daemonUrl, process.env[settings.daemonPasswordEnv]).catch(() => null);
    if (version && range) {
      if (satisfies(version, range)) report("ok", `Paseo ${version}（本版本支持 ${range}）`);
      else report("warn", `Paseo ${version} 不在本版本 req-kit 支持的范围 ${range} 内`, "运行 req upgrade，它会选能支持这个 Paseo 版本的 req-kit");
    }
    const snapshot = await client.providers.waitForReady({ timeoutMs: 30_000 });
    const providers = snapshot.entries.map((e) => `${e.provider}（${e.status}）`).join("、");
    report("ok", `可用的 provider：${providers || "（无）"}`);
    const daemonConfig = await client.config.get().then((r) => r.config as Record<string, unknown>).catch(() => null);
    const paseoProfiles = daemonConfig ? profilesFromDaemonConfig(daemonConfig) : null;
    if (paseoProfiles && paseoProfiles.length > 0) {
      report("ok", `Paseo agent profiles：${paseoProfiles.map((p) => `「${p.name}」`).join("、")}（配置中可以用 "paseoProfile": "<名称>" 引用）`);
    } else if (paseoProfiles) {
      info("Paseo 中还没有 agent profile。可选：在 设置 → Agents → Agent profiles 中建好\"实现\"\"评审\"等 profile，配置中用 paseoProfile 引用，之后换模型只需改 Paseo");
    }
    if (daemonConfig) {
      const mcp = daemonConfig.mcp as { injectIntoAgents?: boolean } | undefined;
      const browser = daemonConfig.browserTools as { enabled?: boolean } | undefined;
      info(
        mcp?.injectIntoAgents
          ? "Paseo 工具已开启：步骤 agent 可以重启 Paseo 管理的服务"
          : "Paseo 工具未开启（设置 → Agents → Enable Paseo tools）。不影响运行；开启后步骤 agent 可以自己重启 Paseo 管理的服务",
      );
      info(browser?.enabled ? "浏览器工具已开启（桌面端）" : "浏览器工具未开启（不影响运行）");
    }
    if (config && usesPaseoProfiles(config)) {
      try {
        config = resolveConfigProfiles(config, paseoProfiles);
        report("ok", `Paseo profile 已解析：builder ${describeAgentProfile(config.agents.builder)}；reviewer ${describeAgentProfile(config.agents.reviewer)}`);
      } catch (error) {
        if (!(error instanceof ProfileResolutionError)) throw error;
        report("fail", error.message, "在 Paseo 中建好这个 profile，或修改配置中的 paseoProfile");
        config = null;
      }
    }
    if (config) {
      const used = [...new Set([config.agents.builder, config.agents.reviewer].map((p) => (p.provider ?? "").split("/")[0]))];
      const usage = await client.providers.listUsage().catch(() => null);
      for (const p of usage?.providers ?? []) {
        if (!used.includes(p.providerId) || p.status !== "available" || p.windows.length === 0) continue;
        info(`${p.displayName} 额度：${p.windows.map((w) => `${w.label} 已用 ${typeof w.usedPct === "number" ? `${Math.round(w.usedPct)}%` : "?"}`).join("，")}`);
      }
    }
    if (config) {
      for (const role of ["builder", "reviewer"] as const) await checkProfile(client, role, config.agents[role], report);
      if (config.reviewPanel.enabled) {
        for (const [i, member] of config.reviewPanel.members.entries()) {
          await checkProfile(client, `评审小组·${member.name ?? `成员 ${i + 1}`}`, member, report);
        }
      }
      if (config.designProposals.enabled) {
        for (const [i, member] of config.designProposals.members.entries()) {
          await checkProfile(client, `方案提案·${member.name ?? `成员 ${i + 1}`}`, member, report);
        }
      }
    } else {
      report("warn", "配置不完整，跳过 agent 检查", "修好配置后再运行一次");
    }
  } catch (error) {
    report("fail", `检查 daemon 时出错：${(error as Error).message}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Files whose change usually means the build, test or start commands changed. */
const BUILD_FILES = [
  "package.json",
  "pnpm-workspace.yaml",
  "Makefile",
  "justfile",
  "docker-compose.yml",
  "compose.yaml",
  "pyproject.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Cargo.toml",
];

function lastCommitTime(repo: string, files: string[]): number | null {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%ct", "--", ...files], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out ? Number(out) * 1000 : null;
  } catch {
    return null;
  }
}

function verifyInstructions(repo: string, isRepo: boolean): void {
  const rel = `${PROJECT_DIR}/verify.md`;
  const file = path.join(repo, PROJECT_DIR, "verify.md");
  if (!fs.existsSync(file)) {
    report("warn", "没有验证方法说明，服务启动和功能验证步骤需要自己摸索，耗时更长、结果更不稳定", "在项目根目录的对话中运行 /req-setup");
    return;
  }
  if (!isRepo) {
    report("ok", `验证方法：${rel}`);
    return;
  }
  const verifyTime = lastCommitTime(repo, [path.join(PROJECT_DIR, "verify.md")]);
  const buildFiles = BUILD_FILES.filter((f) => fs.existsSync(path.join(repo, f)));
  const buildTime = buildFiles.length > 0 ? lastCommitTime(repo, buildFiles) : null;
  if (verifyTime === null) {
    report("warn", `验证方法 ${rel} 还没有提交，其他工作区看不到它`, "确认内容后提交，并合并到主分支");
  } else if (buildTime !== null && buildTime > verifyTime) {
    const day = (ms: number) => new Date(ms).toLocaleDateString("zh-CN");
    report("warn", `验证方法可能过时：构建文件在 ${day(buildTime)} 改过，验证方法最后更新于 ${day(verifyTime)}`, "运行 /req-setup 更新，或确认内容仍然准确");
  } else {
    report("ok", `验证方法：${rel}`);
  }
}

interface RawState {
  version?: number;
  status?: string;
  pid?: number;
  stopReason?: string | null;
}

/** paseo.json: worktree setup and the services Paseo can run for the pipeline. */
function paseoJson(repo: string, isRepo: boolean): void {
  const file = path.join(repo, "paseo.json");
  if (!fs.existsSync(file)) {
    info("没有 paseo.json。可选：/req-setup 可以生成它，让 Paseo 在新建 worktree 时自动安装依赖，并由 Paseo 管理服务和端口（几个需求同时验证也不会端口冲突）");
    return;
  }
  let raw: PaseoJson;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as typeof raw;
  } catch (error) {
    report("fail", `paseo.json 不是合法的 JSON：${(error as Error).message}`, "修正 paseo.json");
    return;
  }
  const scripts = Object.entries(raw.scripts ?? {});
  const services = scripts.filter(([, s]) => s.type === "service");
  report(
    "ok",
    `paseo.json：${raw.worktree?.setup ? "新建 worktree 时自动准备环境；" : ""}脚本 ${scripts.length} 个${services.length ? `，其中服务 ${services.map(([n]) => n).join("、")}（由流水线通过 Paseo 启动）` : ""}`,
  );
  for (const [name, s] of services) {
    if (s.port === undefined && !String(s.command ?? "").includes("PASEO_PORT")) {
      report("warn", `paseo.json 中的服务 ${name} 没有使用 $PASEO_PORT，几个工作区同时运行时会端口冲突`, `让启动命令监听 $PASEO_PORT，例如 "npm run dev -- --port $PASEO_PORT"`);
    }
  }
  if (process.platform === "win32") {
    for (const issue of windowsPaseoJsonIssues(raw)) report("warn", issue.text, issue.fix);
  }
  if (!isRepo) return;
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "paseo.json"], { cwd: repo, stdio: "ignore" });
  } catch {
    report("warn", "paseo.json 还没有提交：Paseo 新建 worktree 时读取的是已提交的版本", "提交 paseo.json");
  }
}

function project(repo: string): void {
  section(`项目：${repo}`);
  const git = gitInfo(repo);
  if (!git.isRepo) {
    report("warn", "不是 git 仓库：流水线可以运行，但不会提交代码");
  } else if (git.detached) {
    report("warn", "当前没有处在任何分支上（detached HEAD），流水线会拒绝启动", "切换到需求的工作分支");
  } else if (git.branch && git.protectedBranches.includes(git.branch)) {
    report("warn", `当前在默认分支 ${git.branch} 上：新需求会被建议改用独立的 worktree 工作区`, "在 Paseo 中 New workspace → Isolation 选 New worktree");
  } else {
    report("ok", `当前分支：${git.branch}`);
  }
  const projectConfig = path.join(repo, PROJECT_CONFIG_FILE);
  if (fs.existsSync(projectConfig)) report("ok", `项目配置：${PROJECT_CONFIG_FILE}`);
  const notes = path.join(repo, PROJECT_DIR, "project-notes.md");
  if (fs.existsSync(notes)) report("ok", `项目说明：${PROJECT_DIR}/project-notes.md`);
  else report("warn", "没有项目说明（包管理工具、不能改的目录、提交格式等），步骤 agent 需要自己摸索", "在项目根目录的对话中运行 /req-setup");
  verifyInstructions(repo, git.isRepo);
  paseoJson(repo, git.isRepo);
  if (!fs.existsSync(path.join(repo, "GLOSSARY.md")) && fs.existsSync(path.join(repo, "CONTEXT.md"))) {
    report("ok", "术语表为旧名 CONTEXT.md：会继续读取，新术语写入 GLOSSARY.md");
  }

  const featuresDir = path.join(repo, "docs", "features");
  if (!fs.existsSync(featuresDir)) {
    report("ok", "还没有需求（docs/features 不存在）");
    return;
  }
  let found = 0;
  for (const name of fs.readdirSync(featuresDir).sort()) {
    const file = path.join(featuresDir, name, ".pipeline", "state.json");
    if (!fs.existsSync(file)) continue;
    found += 1;
    let raw: RawState;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8")) as RawState;
    } catch (error) {
      report("fail", `${name}：状态文件无法读取：${(error as Error).message}`, `检查 ${file}`);
      continue;
    }
    const version = typeof raw.version === "number" ? raw.version : 1;
    if (version > STATE_VERSION) {
      report("fail", `${name}：状态文件由更新版本的 req-kit 写入（第 ${version} 版）`, "升级 req-kit，或恢复同目录下的 state.json.bak-v* 备份");
      continue;
    }
    const migrate = version < STATE_VERSION ? `（格式第 ${version} 版，下次继续时会自动迁移并保留备份）` : "";
    const label = `docs/features/${name}`;
    switch (raw.status) {
      case "running":
        if (raw.pid && isAlive(raw.pid)) report("ok", `${label}：运行中（进程 ${raw.pid}）${migrate}`);
        else report("warn", `${label}：状态为运行中，但进程已不在${migrate}`, `在该需求的对话中对 /req 说"继续开发"，或执行 start-pipeline --feature ${label} --resume`);
        break;
      case "waiting_for_business":
        report("warn", `${label}：等待需求方决定${migrate}`, "在该需求的对话中回答问题、更新 spec 后继续");
        break;
      case "failed":
        report("warn", `${label}：已中断：${raw.stopReason ?? "原因未记录"}${migrate}`, `查看 ${label}/.pipeline/pipeline.log，解决后继续`);
        break;
      case "completed":
        report("ok", `${label}：已完成${migrate}`);
        break;
      default:
        report("warn", `${label}：未知状态 ${raw.status}`);
    }
  }
  if (found === 0) report("ok", "没有运行过流水线的需求");
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      repo: { type: "string" },
      config: { type: "string" },
      "no-project": { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
    },
  });
  const configPath = values.config ? path.resolve(values.config) : defaultConfigPath();
  const repo = values["no-project"] ? null : path.resolve(values.repo ?? process.env.PASEO_AGENT_CWD ?? process.cwd());

  console.log(`req-kit ${kitVersion()} 体检（安装目录 ${KIT_ROOT}）`);
  installation(values.offline ?? false);
  const config = configuration(configPath, repo);
  if (values.offline) {
    section("Paseo daemon");
    console.log("（已跳过：--offline）");
  } else {
    await daemon(config, configPath);
  }
  if (repo) project(repo);

  console.log("");
  if (counts.fail === 0 && counts.warn === 0) console.log("结论：全部正常。");
  else console.log(`结论：${counts.fail} 项必须处理（✗），${counts.warn} 项建议处理（⚠）。`);
  return counts.fail === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: Error) => {
    console.error(`体检出错：${error.message}`);
    process.exit(2);
  },
);
