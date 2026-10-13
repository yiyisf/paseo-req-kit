// --status and --stop: what a chat agent runs when the user asks "how far along
// is it?" or "stop for now". Output is plain language for relaying to the user.

import { PROFILE_LABELS, type PipelineConfig } from "./config.js";
import type { RuntimeFactory } from "./runtime.js";
import { isAlive, type PipelineState, readState, type StepRecord, writeState } from "./state.js";
import { STEPS } from "./steps.js";
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

function resultText(record: StepRecord): string {
  const r = record.result ?? {};
  if (typeof r.has_runnable_service === "boolean") return r.has_runnable_service ? "完成（项目有常驻服务）" : "完成";
  if (typeof r.started === "boolean") return r.started ? "服务启动成功" : "服务启动失败";
  for (const key of ["verdict", "result", "status", "outcome"]) {
    const value = r[key];
    if (typeof value === "string") return RESULT_TEXT[value] ?? value;
  }
  return "完成";
}

function stepName(record: StepRecord): string {
  const title = STEPS[record.stepId].title;
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
        : state.status === "failed"
          ? "已中断，可以继续"
          : `已完成（${RESULT_TEXT[state.outcome ?? ""] ?? state.outcome ?? ""}）`;

  const lines = [
    `需求：${featureDir}（档位：${PROFILE_LABELS[state.profile ?? "standard"]}）`,
    `状态：${statusText}`,
    `开始时间：${new Date(state.startedAt).toLocaleString("zh-CN", { hour12: false })}，距今 ${duration(state.startedAt, now)}`,
  ];
  if (state.stopReason && !running) lines.push(`原因：${state.stopReason}`);

  const records = state.history.filter((h) => h.attempt === state.attempt);
  const current = records.find((h) => h.outcome === "running");
  if (current && running) {
    lines.push(`当前步骤：${stepName(current)}，已进行 ${duration(current.startedAt, now)}`);
  }
  const done = records.filter((h) => h.outcome === "completed");
  if (done.length > 0) {
    lines.push("已完成的步骤：");
    done.forEach((h, i) => {
      const took = h.endedAt ? duration(h.startedAt, new Date(h.endedAt)) : "";
      lines.push(`  ${i + 1}. ${stepName(h)}：${resultText(h)}${took ? `（用时 ${took}）` : ""}`);
    });
  } else if (!current) {
    lines.push("还没有完成的步骤。");
  }
  const failed = records.filter((h) => h.outcome === "failed").at(-1);
  if (failed && !running) lines.push(`中断在：${stepName(failed)}（${failed.error ?? "原因未知"}）`);
  if (records.length > 0) lines.push(`用时与用量：${describeTotals(totals(records, now))}`);
  if (state.attempt > 1) lines.push(`这个需求的全部 ${state.attempt} 次尝试合计：${describeTotals(totals(state.history, now))}`);
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
export async function stopPipeline(input: StopInput): Promise<{ stopped: boolean; message: string }> {
  const state = readState(input.statePath);
  if (!state) return { stopped: false, message: `需求 ${input.featureDir} 还没有启动过开发流水线。` };
  if (state.status !== "running") {
    return { stopped: false, message: `流水线当前没有在运行（${describeStatus(state, input.featureDir).split("\n")[1]}）。` };
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

  const where = interrupted.length > 0 ? `，停在「${stepName(interrupted[0])}」` : "";
  return {
    stopped: true,
    message: wasAlive
      ? `流水线已停止${where}。已完成的步骤会保留，之后可以用 --resume 从这里继续。`
      : `流水线的后台进程已经意外退出${where}，状态已更新。可以用 --resume 继续。`,
  };
}
