// --status and --stop: what a chat agent runs when the user asks "how far along
// is it?" or "stop for now". Output is plain language for relaying to the user.

import { describeActivity } from "./activity.js";
import { PHASE_MODE_LABELS, PROFILE_LABELS, type PipelineConfig, REQUIREMENT_TYPE_LABELS } from "./config.js";
import type { AgentRuntime, RuntimeFactory } from "./runtime.js";
import { isAlive, type PipelineState, readState, type StepRecord, writeState } from "./state.js";
import { stepTitle } from "./playbooks.js";
import { describeTotals, totals } from "./usage.js";

export function duration(fromIso: string, to: Date = new Date()): string {
  const minutes = Math.floor((to.getTime() - new Date(fromIso).getTime()) / 60_000);
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
}

const RESULT_TEXT: Record<string, string> = {
  approved: "通过",
  changes_required: "需要修改",
  blocked: "需要需求方决定",
  pass: "通过",
  defects_found: "发现问题",
  defects_remaining: "仍有问题",
  done: "完成",
  partial: "部分完成",
  completed: "已完成，可以验收",
  completed_with_issues: "已完成，有遗留问题",
  not_completed: "未完成",
};

export function resultText(record: StepRecord): string {
  const r = record.result ?? {};
  if (typeof r.has_runnable_service === "boolean") return r.has_runnable_service ? "完成（项目有常驻服务）" : "完成";
  if (typeof r.started === "boolean") return r.started ? "服务启动成功" : "服务启动失败";
  for (const key of ["verdict", "result", "status", "outcome"]) {
    const value = r[key];
    if (typeof value === "string") return RESULT_TEXT[value] ?? value;
  }
  return "完成";
}

export function stepName(record: StepRecord, state: Pick<PipelineState, "type" | "joint"> | null = null): string {
  const [base, slug] = record.key.split("@");
  const repo = slug ? (state?.joint ?? []).find((j) => j.slug === slug)?.name ?? slug : null;
  const title = `${stepTitle(state?.type, record.stepId)}${repo ? `·${repo}` : ""}`;
  const slice = /^implement-s(\d+)$/.exec(base);
  if (slice) return `${title}（第 ${slice[1]} 片）`;
  return record.round !== null ? `${title}（第 ${record.round} 轮）` : title;
}

export function describeStatus(state: PipelineState | null, featureDir: string, now = new Date()): string {
  if (!state) return `需求 ${featureDir} 还没有启动过开发流水线。`;
  const running = state.status === "running" && isAlive(state.pid);
  const statusText = running
    ? "运行中"
    : state.status === "running"
      ? "已中断（后台进程意外退出，可以继续）"
      : state.status === "waiting_for_business"
        ? "已暂停，等待需求方决定"
        : state.status === "waiting_for_approval"
          ? "已暂停，等待需求方确认方案（做完后会看到什么，见功能目录中的 preview.md）"
        : state.status === "phase_done"
          ? "研发完成，待测试验证（提测说明见功能目录中的 handoff.md）"
        : state.status === "failed"
          ? "已中断，可以继续"
          : state.phases?.mode === "develop-only" && state.phase !== "verify"
            ? `研发已完成，待人工测试（只做研发；研发结论：${RESULT_TEXT[state.outcome ?? ""] ?? state.outcome ?? ""}）`
            : `已完成（${RESULT_TEXT[state.outcome ?? ""] ?? state.outcome ?? ""}）`;

  const lines = [
    `需求：${featureDir}（档位：${PROFILE_LABELS[state.profile ?? "standard"]}${state.type ? `，类型：${REQUIREMENT_TYPE_LABELS[state.type]}` : ""}）`,
    `状态：${running && state.queuedSince ? `排队中（本机同时运行的流水线已达上限，自 ${new Date(state.queuedSince).toLocaleString("zh-CN", { hour12: false })} 起等待，轮到时自动开始）` : statusText}`,
    ...(state.phases && state.phases.mode !== "continuous"
      ? [`执行方式：${PHASE_MODE_LABELS[state.phases.mode]}（当前阶段：${state.phase === "verify" ? "测试验证" : "研发"}${state.handbacks ? `，测试已退回 ${state.handbacks} 次` : ""}）`]
      : []),
    `开始时间：${new Date(state.startedAt).toLocaleString("zh-CN", { hour12: false })}，距今 ${duration(state.startedAt, now)}`,
  ];
  if (state.stopReason && !running) lines.push(`原因：${state.stopReason}`);
  for (const j of state.joint ?? []) lines.push(`联合开发：${j.name} 在工作区 ${j.repo}（分支 ${j.branch}）`);
  const KIND_TEXT = { reminder: "提醒", "auto-resume": "自动继续", watchdog: "定时检查", "verify-start": "开始测试验证", "approval-continue": "未确认时按方案继续" } as const;
  for (const s of state.schedules ?? []) {
    if (s.kind === "watchdog" && !running) continue;
    const when = s.at ? `${new Date(s.at).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} ` : "";
    lines.push(`已预约：${when}${KIND_TEXT[s.kind]}（Paseo 定时任务，执行暂停命令可以取消）`);
  }

  const records = state.history.filter((h) => h.attempt === state.attempt);
  const current = records.find((h) => h.outcome === "running");
  if (current && running) {
    lines.push(`当前步骤：${stepName(current, state)}，已进行 ${duration(current.startedAt, now)}`);
  }
  const done = records.filter((h) => h.outcome === "completed");
  if (done.length > 0) {
    lines.push("已完成的步骤：");
    done.forEach((h, i) => {
      const took = h.endedAt ? duration(h.startedAt, new Date(h.endedAt)) : "";
      lines.push(`  ${i + 1}. ${stepName(h, state)}：${resultText(h)}${took ? `（用时 ${took}）` : ""}`);
    });
  } else if (!current) {
    lines.push("还没有完成的步骤。");
  }
  const failed = records.filter((h) => h.outcome === "failed").at(-1);
  if (failed && !running) lines.push(`中断在：${stepName(failed, state)}（${failed.error ?? "原因未知"}）`);
  const gateRuns = (state.gate?.runs ?? []).filter((r) => r.attempt === state.attempt);
  const lastGate = gateRuns.at(-1);
  if (lastGate) {
    lines.push(
      lastGate.passed
        ? `质量门（流水线自己运行的检查）：最近一次通过（${lastGate.key} 之后）`
        : `质量门（流水线自己运行的检查）：${lastGate.newFailures.join("、")} 在 ${lastGate.key} 之后仍失败，已交给代码评审和报告`,
    );
  }
  if (records.length > 0) lines.push(`用时与用量：${describeTotals(totals(records, now))}`);
  if (state.attempt > 1) lines.push(`这个需求的全部 ${state.attempt} 次尝试合计：${describeTotals(totals(state.history, now))}`);
  if (state.phases && state.phases.mode !== "continuous") {
    const verify = state.history.filter((h) => h.phase === "verify");
    if (verify.length > 0) {
      lines.push(`其中研发阶段：${describeTotals(totals(state.history.filter((h) => (h.phase ?? "develop") === "develop"), now))}；测试验证阶段：${describeTotals(totals(verify, now))}`);
    }
  }
  return lines.join("\n");
}

export interface StopInput {
  statePath: string;
  featureDir: string;
  config: PipelineConfig;
  createRuntime: RuntimeFactory;
  log: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
}

/** Stops a running pipeline and its current step agent. Returns the message for the user. */
/** Cancels the Paseo schedules a run left (reminder, automatic continuation, watchdog). */
async function cancelSchedules(input: StopInput, state: PipelineState): Promise<number> {
  const schedules = state.schedules ?? [];
  if (schedules.length === 0) return 0;
  try {
    const runtime = await input.createRuntime({ config: input.config, log: input.log });
    for (const s of schedules) await runtime.cancelSchedule(s.id).catch((error: Error) => input.log(`无法取消定时任务 ${s.id}：${error.message}`));
    await runtime.close().catch(() => undefined);
  } catch (error) {
    input.log(`无法连接 Paseo 取消定时任务：${(error as Error).message}`);
    return 0;
  }
  const latest = readState(input.statePath) ?? state;
  latest.schedules = [];
  writeState(input.statePath, latest);
  return schedules.length;
}

export async function stopPipeline(input: StopInput): Promise<{ stopped: boolean; message: string }> {
  const state = readState(input.statePath);
  if (!state) return { stopped: false, message: `需求 ${input.featureDir} 还没有启动过开发流水线。` };
  const cancelled = await cancelSchedules(input, state);
  const cancelledText = cancelled > 0 ? `已取消预约的提醒或自动继续（${cancelled} 个）。` : "";
  if (state.status !== "running") {
    return {
      stopped: cancelled > 0,
      message: `${cancelledText}流水线当前没有在运行（${describeStatus(state, input.featureDir).split("\n")[1]}）。`,
    };
  }

  const wasAlive = isAlive(state.pid);
  if (wasAlive) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    for (let i = 0; i < 20 && isAlive(state.pid); i++) await input.sleep(250);
    if (isAlive(state.pid)) {
      try {
        process.kill(state.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }

  // Re-read: on POSIX the pipeline records its own shutdown before exiting.
  const latest = readState(input.statePath) ?? state;
  const interrupted = latest.history.filter((h) => h.outcome === "running" || (h.endedAt === null && h.agentId));
  for (const record of interrupted) {
    record.outcome = "failed";
    record.endedAt = new Date().toISOString();
    record.error = "被手动停止";
  }
  latest.status = "failed";
  latest.stopReason = wasAlive ? "已被手动停止" : "后台进程已意外退出";
  writeState(input.statePath, latest);

  // The step agent keeps working unless told otherwise; stop it so it changes nothing more.
  if (interrupted.some((r) => r.agentId)) {
    try {
      const runtime = await input.createRuntime({ config: input.config, log: input.log });
      for (const record of interrupted) {
        if (!record.agentId) continue;
        await runtime
          .interruptAgent(
            record.agentId,
            "开发流水线已被用户停止。请立即停止当前工作，不要再修改任何文件，也不要写结果文件，直接结束。",
          )
          .catch((error: Error) => input.log(`无法停止 agent ${record.agentId}：${error.message}`));
      }
      await runtime.close().catch(() => undefined);
    } catch (error) {
      input.log(`无法连接 Paseo 停止当前步骤的 agent：${(error as Error).message}`);
    }
  }

  const where = interrupted.length > 0 ? `，停在「${stepName(interrupted[0], latest)}」` : "";
  return {
    stopped: true,
    message: wasAlive
      ? `流水线已停止${where}。已完成的步骤会保留，之后可以用 --resume 从这里继续。`
      : `流水线的后台进程已经意外退出${where}，状态已更新。可以用 --resume 继续。`,
  };
}

/**
 * What the running step agents did most recently, read from Paseo. Empty when the
 * pipeline is not running or the daemon cannot be reached within `timeoutMs`.
 */
export async function describeLiveActivity(
  state: PipelineState | null,
  runtime: Pick<AgentRuntime, "recentActivity">,
  timeoutMs = 8000,
  now = new Date(),
): Promise<string[]> {
  if (!state || state.status !== "running" || !isAlive(state.pid)) return [];
  const running = state.history.filter((h) => h.attempt === state.attempt && h.outcome === "running" && h.agentId).slice(0, 3);
  const lines: string[] = [];
  for (const record of running) {
    const items = await Promise.race([
      runtime.recentActivity(record.agentId, 5).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs).unref()),
    ]);
    if (!items || items.length === 0) continue;
    lines.push(`「${stepName(record, state)}」的 agent 最近在做：`, ...describeActivity(items, now));
  }
  return lines;
}
