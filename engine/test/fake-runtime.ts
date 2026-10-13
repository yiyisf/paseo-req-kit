// A scripted stand-in for the Paseo daemon, used by the tests through
// REQ_PIPELINE_FAKE_RUNTIME. Each "agent" reads its <pipeline-context>, writes
// the step's artifact and result file the way a real agent would, and records
// what the pipeline asked of it in FAKE_EVENTS (one JSON object per line).

import fs from "node:fs";
import path from "node:path";
import type { AgentRuntime, RuntimeFactory, StepAgent, WaitOutcome } from "../src/runtime.js";

export interface FakeBehavior {
  result?: Record<string, unknown>;
  /** Turn ends with an error status. */
  error?: string;
  /** Agent never finishes (every wait times out). */
  hang?: boolean;
  /** First waits report a pending permission request, then the turn finishes. */
  permission?: boolean;
  /** First turn ends without writing the result file; a follow-up fixes it. */
  skipResultFirst?: boolean;
  /** First turn writes a result that fails validation; a follow-up fixes it. */
  invalidFirst?: boolean;
  /** Never writes a valid result, whatever the follow-ups say. */
  neverWritesResult?: boolean;
  /** The first N agents started for this step end with a transient (rate-limit) error. */
  transientErrors?: number;
}

export interface FakeScenario {
  /** Working directory the launching chat reports; defaults to the repository. */
  originCwd?: string;
  /** The launching chat no longer exists. */
  originMissing?: boolean;
  /** Behaviors by step key ("code_review-r2") or step id ("code_review"). */
  steps?: Record<string, FakeBehavior>;
  notifyFails?: boolean;
}

const DEFAULT_RESULTS: Record<string, Record<string, unknown>> = {
  design: { has_runnable_service: false },
  design_review: { verdict: "approved" },
  design_revise: { status: "done" },
  implement: { status: "done" },
  code_review: { verdict: "pass" },
  review_fix: { status: "done" },
  service_start: { started: true },
  verify: { result: "pass" },
  defect_fix: { status: "done" },
  reverify: { result: "pass" },
  report: { outcome: "completed", summary: "短信登录已经做好，可以验收。" },
  panel_review: { status: "done" },
};

const ARTIFACTS: Record<string, string> = {
  design: "design.md",
  design_review: "design-review.md",
  design_revise: "design.md",
  implement: "implementation.md",
  code_review: "code-review.md",
  review_fix: "code-review.md",
  service_start: "service-start.md",
  verify: "verification.md",
  defect_fix: "verification.md",
  reverify: "verification.md",
  report: "report.md",
};

function record(event: Record<string, unknown>): void {
  const file = process.env.FAKE_EVENTS;
  if (file) fs.appendFileSync(file, `${JSON.stringify({ ...event, at: Date.now() })}\n`);
}

function contextValue(prompt: string, label: string): string {
  const match = new RegExp(`^${label}：(.+)$`, "m").exec(prompt);
  if (!match) throw new Error(`prompt is missing "${label}" in <pipeline-context>`);
  return match[1].trim();
}

export const createRuntime: RuntimeFactory = async () => {
  const scenarioFile = process.env.FAKE_SCENARIO;
  const scenario: FakeScenario = scenarioFile ? JSON.parse(fs.readFileSync(scenarioFile, "utf8")) : {};
  let counter = 0;
  const startsByKey = new Map<string, number>();

  const runtime: AgentRuntime = {
    async verifyOrigin(agentId, cwd) {
      record({ type: "verifyOrigin", agentId, cwd });
      if (scenario.originMissing) throw new Error(`找不到发起对话的 agent ${agentId}（可能已被归档）。`);
      if (scenario.originCwd && scenario.originCwd !== cwd) {
        throw new Error(`发起对话的工作目录是 ${scenario.originCwd}，与仓库目录 ${cwd} 不一致。`);
      }
    },
    async startAgent(input) {
      counter += 1;
      const id = `fake-agent-${counter}`;
      const resultRel = contextValue(input.prompt, "结果文件");
      const featureDir = contextValue(input.prompt, "功能目录");
      const key = path.basename(resultRel, ".json");
      const isPanel = /-p\d+$/.test(key);
      const stepId = isPanel ? "panel_review" : key.replace(/-r\d+$/, "");
      const behavior: FakeBehavior = scenario.steps?.[key] ?? scenario.steps?.[stepId] ?? {};
      const result = behavior.result ?? DEFAULT_RESULTS[stepId];
      const resultAbs = path.join(input.cwd, resultRel);
      const startNumber = (startsByKey.get(key) ?? 0) + 1;
      startsByKey.set(key, startNumber);
      const transient = startNumber <= (behavior.transientErrors ?? 0);

      record({
        type: "start",
        agentId: id,
        key,
        role: input.role,
        provider: input.profile?.provider ?? null,
        title: input.title,
        parentAgentId: input.parentAgentId,
        labels: input.labels,
        hasSharedContext: input.prompt.includes("# 背景：你在一条需求开发流水线中"),
        hasStepTask: input.prompt.includes("# 本步骤任务"),
        prompt: input.prompt,
      });

      let turn = 0;
      let turnPending = true;
      let permissionWaits = 0;

      const finishTurn = () => {
        if (isPanel) {
          const findings = path.join(input.cwd, contextValue(input.prompt, "你的意见文件"));
          fs.mkdirSync(path.dirname(findings), { recursive: true });
          fs.appendFileSync(findings, `## ${key} 的意见（模拟评审者）\n`);
        } else {
          const artifact = path.join(input.cwd, featureDir, ARTIFACTS[stepId]);
          fs.appendFileSync(artifact, `\n## ${key}（模拟 agent，第 ${turn + 1} 个回合）\n`);
          fs.appendFileSync(path.join(input.cwd, featureDir, "progress.md"), `- ${key}：完成\n`);
        }
        if (behavior.neverWritesResult) return;
        if (turn === 0 && behavior.skipResultFirst) return;
        if (turn === 0 && behavior.invalidFirst) {
          fs.writeFileSync(resultAbs, '{"verdict": "looks good"}');
          return;
        }
        fs.writeFileSync(resultAbs, JSON.stringify(result));
      };

      const agent: StepAgent = {
        id,
        async wait(timeoutMs): Promise<WaitOutcome> {
          await new Promise((resolve) => setTimeout(resolve, 5));
          const base = {
            error: null,
            lastMessage: "完成",
            pendingPermissions: [],
            usage: { inputTokens: 12_000, outputTokens: 800, totalCostUsd: 0.05 },
          };
          if (behavior.hang) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 50)));
            return { ...base, status: "timeout" };
          }
          if (behavior.error) return { ...base, status: "error", error: behavior.error };
          if (transient) return { ...base, status: "error", error: "provider error: rate limit exceeded (429)" };
          if (behavior.permission && turn === 0 && permissionWaits < 2) {
            permissionWaits += 1;
            // The same request is reported on every check until someone answers it.
            return {
              ...base,
              status: "permission",
              pendingPermissions: [{ id: "perm-1", title: "运行 npm install" }],
            };
          }
          if (turnPending) {
            finishTurn();
            turnPending = false;
          }
          return { ...base, status: "idle" };
        },
        async followUp(text) {
          turn += 1;
          turnPending = true;
          record({ type: "followUp", agentId: id, key, text });
        },
        async archive() {
          record({ type: "archive", agentId: id, key });
        },
      };
      return agent;
    },
    async interruptAgent(agentId, text) {
      record({ type: "interrupt", agentId, text });
    },
    async notifyAgent(agentId, text) {
      record({ type: "notify", agentId, text });
      if (scenario.notifyFails) throw new Error("agent archived");
    },
    async close() {
      record({ type: "close" });
    },
  };
  return runtime;
};
