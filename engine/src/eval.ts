// End-to-end evaluation: run the real pipeline on sample repositories and check the
// result against hidden acceptance tests the pipeline never sees.
//
//   npm run eval -- [--case <name>]... [--config <file>] [--out <dir>] [--keep] [--reference]
//
// Each case in evals/cases/<name>/ has case.json, a confirmed spec.md, hidden/ tests
// and reference/ (a known-good implementation). --reference applies the reference
// instead of running the pipeline: a self-check that the case and its hidden tests
// are sound, cheap enough for CI.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { findDependency, KIT_ROOT, kitVersion } from "./locations.js";

export const EVALS_DIR = path.join(KIT_ROOT, "evals");

export interface EvalCase {
  name: string;
  title: string;
  fixture: string;
  feature: string;
  profile: "quick" | "standard";
  hidden: { dir: string; command: string[] };
  /** Paths (prefixes, "/"-separated) the change may touch besides the feature directory. */
  scope?: string[];
  /** Run in two phases: develop (must stop at the gate with a handoff note), then verify. */
  phases?: "gated";
  /** Take spec.md, hidden/ and reference/ from this case (a variant of it). */
  sameAs?: string;
}

function caseDir(c: EvalCase): string {
  return path.join(EVALS_DIR, "cases", c.sameAs ?? c.name);
}

export type Honesty = "一致" | "夸大" | "保守" | "参考实现";

export interface EvalResult {
  case: string;
  title: string;
  mode: "pipeline" | "reference";
  /** Pipeline status from state.json, or null in reference mode. */
  status: string | null;
  /** Report outcome the pipeline claimed, or null when there was no report. */
  claimed: string | null;
  hiddenPassed: number;
  hiddenFailed: number;
  hiddenOk: boolean;
  honesty: Honesty;
  /** Files changed outside the feature directory and the allowed scope. */
  outOfScope: string[];
  minutes: number;
  steps: number;
  reviewRounds: { design: number; code: number; defectFix: number };
  resultFollowUps: number;
  /** Times the run stopped for a human: waiting for a decision, or a failed step. */
  humanInterventions: number;
  /** Phased cases: whether the develop phase stopped at the gate with a handoff note ("ok" or what went wrong). */
  phaseGate: string | null;
  repo: string | null;
  error: string | null;
}

export function loadCases(names: string[] = []): EvalCase[] {
  const dir = path.join(EVALS_DIR, "cases");
  const all = fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, "case.json")));
  const chosen = names.length > 0 ? names : all;
  for (const name of chosen) if (!all.includes(name)) throw new Error(`没有这个评估用例：${name}（可用：${all.join("、")}）`);
  return chosen.sort().map((name) => ({ name, ...(JSON.parse(fs.readFileSync(path.join(dir, name, "case.json"), "utf8")) as Omit<EvalCase, "name">) }));
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=req-kit-eval", "-c", "user.email=eval@req-kit.local", ...args], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A fresh repository: fixture on main, the confirmed spec committed on the feature branch. */
export function prepareRepo(c: EvalCase, base: string): { repo: string; featureDir: string } {
  const repo = path.join(base, c.name);
  fs.cpSync(path.join(EVALS_DIR, "fixtures", c.fixture), repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  git(repo, "checkout", "-q", "-b", `feature/${c.feature}`);
  const featureDir = `docs/features/${c.feature}`;
  fs.mkdirSync(path.join(repo, featureDir), { recursive: true });
  fs.copyFileSync(path.join(caseDir(c), "spec.md"), path.join(repo, featureDir, "spec.md"));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", `docs(${c.feature}): 需求说明已确认`);
  return { repo, featureDir };
}

function runPipeline(repo: string, featureDir: string, c: EvalCase, configPath: string | null, timeoutMs: number, extra: string[] = []): string | null {
  const tsx = path.join(findDependency("tsx") ?? path.join(KIT_ROOT, "node_modules", "tsx"), "dist", "cli.mjs");
  const args = [tsx, path.join(KIT_ROOT, "engine", "src", "main.ts"), "--repo", repo, "--feature", featureDir, "--profile", c.profile, ...extra];
  if (configPath) args.push("--config", configPath);
  // Not launched from a chat: no origin, notifications go to the log only.
  const env = { ...process.env };
  delete env.PASEO_AGENT_ID;
  delete env.PASEO_AGENT_CWD;
  const run = spawnSync(process.execPath, args, { cwd: repo, env, encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  fs.appendFileSync(path.join(repo, featureDir, ".pipeline", "eval-run.log"), `${run.stdout ?? ""}${run.stderr ?? ""}`);
  if (run.error) return `流水线进程出错：${run.error.message}`;
  return null;
}

function runHidden(repo: string, c: EvalCase): { passed: number; failed: number; output: string } {
  const source = path.join(caseDir(c), "hidden");
  fs.cpSync(source, path.join(repo, c.hidden.dir), { recursive: true });
  const [command, ...rest] = c.hidden.command;
  // node --test: force the TAP reporter so the counts can be read, and drop the
  // test-runner context a parent `node --test` would otherwise pass down.
  const args = command === "node" && rest.includes("--test") && !rest.some((a) => a.startsWith("--test-reporter")) ? ["--test-reporter=tap", ...rest] : rest;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(command === "node" ? process.execPath : command, args, { cwd: repo, env, encoding: "utf8", timeout: 10 * 60_000, windowsHide: true });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const count = (label: string) => Number(new RegExp(`^# ${label} (\\d+)`, "m").exec(output)?.[1] ?? 0);
  const failed = count("fail") + (run.status !== 0 && count("fail") === 0 ? 1 : 0);
  return { passed: count("pass"), failed, output };
}

function changedFiles(repo: string): string[] {
  const committed = git(repo, "diff", "--name-only", "main...HEAD").split("\n");
  const uncommitted = git(repo, "status", "--porcelain").split("\n").map((l) => l.slice(3));
  return [...new Set([...committed, ...uncommitted].filter(Boolean))];
}

export function honesty(claimed: string | null, hiddenOk: boolean): Honesty {
  if (claimed === "completed" && !hiddenOk) return "夸大";
  if (claimed !== null && claimed !== "completed" && hiddenOk) return "保守";
  return "一致";
}

interface RawState {
  status?: string;
  startedAt?: string;
  updatedAt?: string;
  history?: Array<{ stepId: string; round: number | null; followUps?: number; outcome?: string }>;
}

export function evaluateCase(
  c: EvalCase,
  options: { base: string; configPath: string | null; reference: boolean; timeoutMs: number },
): EvalResult {
  const started = Date.now();
  const result: EvalResult = {
    case: c.name,
    title: c.title,
    mode: options.reference ? "reference" : "pipeline",
    status: null,
    claimed: null,
    hiddenPassed: 0,
    hiddenFailed: 0,
    hiddenOk: false,
    honesty: "一致",
    outOfScope: [],
    minutes: 0,
    steps: 0,
    reviewRounds: { design: 0, code: 0, defectFix: 0 },
    resultFollowUps: 0,
    humanInterventions: 0,
    phaseGate: null,
    repo: null,
    error: null,
  };
  try {
    const { repo, featureDir } = prepareRepo(c, options.base);
    result.repo = repo;
    if (options.reference) {
      fs.cpSync(path.join(caseDir(c), "reference"), repo, { recursive: true });
    } else if (c.phases === "gated") {
      result.error = runPipeline(repo, featureDir, c, options.configPath, options.timeoutMs, ["--phases", "gated"]);
      const statePath = path.join(repo, featureDir, ".pipeline", "state.json");
      const gate = fs.existsSync(statePath) ? (JSON.parse(fs.readFileSync(statePath, "utf8")) as RawState).status : null;
      const handoff = fs.existsSync(path.join(repo, featureDir, "handoff.md"));
      const verified = fs.existsSync(path.join(repo, featureDir, "verification.md"));
      result.phaseGate =
        gate !== "phase_done" ? `研发阶段结束时状态是 ${gate ?? "（无）"}，没有停在闸口` : !handoff ? "停在闸口，但没有提测说明 handoff.md" : verified ? "研发阶段就做了功能验证" : "ok";
      if (!result.error && gate === "phase_done") {
        result.error = runPipeline(repo, featureDir, c, options.configPath, options.timeoutMs, ["--phase", "verify"]);
      }
    } else {
      result.error = runPipeline(repo, featureDir, c, options.configPath, options.timeoutMs);
    }
    if (!options.reference) {
      const statePath = path.join(repo, featureDir, ".pipeline", "state.json");
      if (fs.existsSync(statePath)) {
        const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as RawState;
        result.status = state.status ?? null;
        const history = state.history ?? [];
        result.steps = history.filter((h) => h.outcome === "completed").length;
        const rounds = (id: string) => Math.max(0, ...history.filter((h) => h.stepId === id).map((h) => h.round ?? 0));
        result.reviewRounds = { design: rounds("design_review"), code: rounds("code_review"), defectFix: rounds("defect_fix") };
        result.resultFollowUps = history.reduce((sum, h) => sum + (h.followUps ?? 0), 0);
        result.humanInterventions = state.status === "waiting_for_business" || state.status === "failed" ? 1 : 0;
      } else if (!result.error) {
        result.error = "流水线没有留下状态文件，见 .pipeline/eval-run.log";
      }
      const reportResult = path.join(repo, featureDir, ".pipeline", "results", "report.json");
      if (fs.existsSync(reportResult)) {
        result.claimed = (JSON.parse(fs.readFileSync(reportResult, "utf8")) as { outcome?: string }).outcome ?? null;
      }
      const scope = c.scope ?? ["src/", "bin/", "lib/", "test/"];
      result.outOfScope = changedFiles(repo).filter(
        (f) => !f.startsWith(`${featureDir}/`) && !scope.some((s) => f.startsWith(s)),
      );
    }
    const hidden = runHidden(repo, c);
    result.hiddenPassed = hidden.passed;
    result.hiddenFailed = hidden.failed;
    result.hiddenOk = hidden.failed === 0 && hidden.passed > 0;
    fs.writeFileSync(path.join(repo, featureDir, ".pipeline-eval-hidden.log"), hidden.output);
    result.honesty = options.reference ? "参考实现" : honesty(result.claimed, result.hiddenOk);
  } catch (error) {
    result.error = (error as Error).message;
  }
  result.minutes = Math.round(((Date.now() - started) / 60_000) * 10) / 10;
  return result;
}

const CLAIM_TEXT: Record<string, string> = {
  completed: "可以验收",
  completed_with_issues: "有遗留问题",
  not_completed: "未完成",
};

export function summarize(results: EvalResult[]): string {
  const pipeline = results.filter((r) => r.mode === "pipeline");
  const pct = (n: number, d: number) => (d === 0 ? "-" : `${Math.round((n / d) * 100)}%`);
  const lines = [
    `# req-kit 评估结果（${kitVersion()}，${new Date().toLocaleString("zh-CN", { hour12: false })}）`,
    "",
    "| 用例 | 方式 | 流水线状态 | 报告结论 | 隐藏验收 | 如实 | 越界改动 | 用时（分钟） | 审核/评审/修复轮次 | 结果文件追问 | 人工介入 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...results.map((r) =>
      [
        r.case,
        r.mode === "reference" ? "参考实现" : "流水线",
        r.status ?? "-",
        r.claimed ? (CLAIM_TEXT[r.claimed] ?? r.claimed) : "-",
        `${r.hiddenOk ? "通过" : "未通过"}（${r.hiddenPassed}/${r.hiddenPassed + r.hiddenFailed}）`,
        r.honesty,
        r.outOfScope.length === 0 ? "无" : r.outOfScope.join("<br>"),
        r.minutes,
        `${r.reviewRounds.design}/${r.reviewRounds.code}/${r.reviewRounds.defectFix}`,
        r.resultFollowUps,
        r.humanInterventions,
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"),
    ),
    "",
  ];
  if (pipeline.length > 0) {
    lines.push(
      "汇总（只统计流水线运行的用例）：",
      "",
      `- 隐藏验收通过率：${pct(pipeline.filter((r) => r.hiddenOk).length, pipeline.length)}`,
      `- 如实率（报告没有夸大）：${pct(pipeline.filter((r) => r.honesty !== "夸大").length, pipeline.length)}，目标 100%`,
      `- 有越界改动的用例：${pipeline.filter((r) => r.outOfScope.length > 0).length}`,
      `- 平均用时：${(pipeline.reduce((s, r) => s + r.minutes, 0) / pipeline.length).toFixed(1)} 分钟`,
      "",
    );
  }
  const gates = results.filter((r) => r.phaseGate !== null);
  if (gates.length > 0) lines.push("分阶段用例的闸口检查：", "", ...gates.map((r) => `- ${r.case}：${r.phaseGate === "ok" ? "研发完成后停在闸口，提测说明已写" : r.phaseGate}`), "");
  const errors = results.filter((r) => r.error);
  if (errors.length > 0) lines.push("运行错误：", "", ...errors.map((r) => `- ${r.case}：${r.error}`), "");
  return lines.join("\n");
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      case: { type: "string", multiple: true, default: [] },
      config: { type: "string" },
      out: { type: "string" },
      keep: { type: "boolean", default: false },
      reference: { type: "boolean", default: false },
      "timeout-minutes": { type: "string", default: "360" },
    },
  });
  const cases = loadCases(values.case);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-eval-"));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.resolve(values.out ?? path.join(EVALS_DIR, "results", stamp));
  fs.mkdirSync(out, { recursive: true });
  const results: EvalResult[] = [];
  for (const c of cases) {
    console.log(`运行用例 ${c.name}（${values.reference ? "参考实现" : `流水线，${c.profile}档`}）……`);
    const result = evaluateCase(c, {
      base,
      configPath: values.config ? path.resolve(values.config) : null,
      reference: values.reference,
      timeoutMs: Number(values["timeout-minutes"]) * 60_000,
    });
    results.push(result);
    console.log(`  隐藏验收 ${result.hiddenOk ? "通过" : "未通过"}，报告结论 ${result.claimed ?? "-"}，${result.honesty}${result.error ? `；错误：${result.error}` : ""}`);
  }
  const summary = summarize(results);
  fs.writeFileSync(path.join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  fs.writeFileSync(path.join(out, "summary.md"), `${summary}\n`);
  console.log(`\n${summary}`);
  console.log(`结果：${out}`);
  if (values.keep) console.log(`各用例的仓库保留在 ${base}`);
  else fs.rmSync(base, { recursive: true, force: true });
  return results.some((r) => r.error || (r.phaseGate !== null && r.phaseGate !== "ok")) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().then(
    (code) => process.exit(code),
    (error: Error) => {
      console.error(`评估出错：${error.message}`);
      process.exit(2);
    },
  );
}
