// req-kit doctor: read-only health check, run by the /req-doctor skill.
//
//   node bin/req-doctor.mjs [--repo <dir>] [--no-project] [--offline] [--config <file>]
//
// Sections: installation (delegated to install.mjs --check), configuration,
// Paseo daemon, and the current project with its pipelines.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, DEFAULT_CONFIG, loadConfig, type PipelineConfig, PROJECT_CONFIG_FILE } from "./config.js";
import { checkProfile, connect, type Report, satisfies } from "./daemon-check.js";
import { gitInfo } from "./git.js";
import { defaultConfigPath, KIT_ROOT, kitVersion } from "./locations.js";
import { PROJECT_DIR } from "./prompts.js";
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

function installation(): void {
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
  const pkg = path.join(KIT_ROOT, "node_modules", "@getpaseo", "client", "package.json");
  const range = readPaseoRange();
  if (fs.existsSync(pkg) && range) {
    const sdk = (JSON.parse(fs.readFileSync(pkg, "utf8")) as { version: string }).version;
    if (satisfies(sdk, range)) report("ok", `Paseo SDK ${sdk}（本版本支持 ${range}）`);
    else report("warn", `Paseo SDK ${sdk} 不在本版本支持的范围 ${range} 内`, "确认 Paseo 与 req-kit 版本匹配，必要时升级 req-kit");
  }
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
    report("ok", `builder：${builder.provider}${builder.modeId ? `（${builder.modeId}）` : ""}；reviewer：${reviewer.provider}${reviewer.modeId ? `（${reviewer.modeId}）` : ""}`);
    report("ok", `默认档位：${loaded.config.defaultProfile}`);
    const panel = loaded.config.reviewPanel;
    if (panel.enabled) {
      report("ok", `评审小组：${panel.members.length} 位成员，用于 ${panel.steps.join("、")}（${panel.profiles.join("、")}档，首轮）`);
      if (panel.members.length === 1) report("warn", "评审小组只有 1 位成员，效果接近单人评审", "建议配置 2–3 位，使用不同厂商的模型");
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
    const snapshot = await client.providers.waitForReady({ timeoutMs: 30_000 });
    const providers = snapshot.entries.map((e) => `${e.provider}（${e.status}）`).join("、");
    report("ok", `可用的 provider：${providers || "（无）"}`);
    if (config) {
      for (const role of ["builder", "reviewer"] as const) await checkProfile(client, role, config.agents[role], report);
      if (config.reviewPanel.enabled) {
        for (const [i, member] of config.reviewPanel.members.entries()) {
          await checkProfile(client, `评审小组·${member.name ?? `成员 ${i + 1}`}`, member, report);
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
  installation();
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
