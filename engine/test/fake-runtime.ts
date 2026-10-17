// A scripted stand-in for the Paseo daemon, used by the tests through
// REQ_PIPELINE_FAKE_RUNTIME. Each "agent" reads its <pipeline-context>, writes
// the step's artifact and result file the way a real agent would, and records
// what the pipeline asked of it in FAKE_EVENTS (one JSON object per line).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PaseoProfile } from "../src/paseo-profiles.js";
import type { ActivityItem, AgentRuntime, ManagedService, ProviderQuota, RuntimeFactory, StepAgent, WaitOutcome } from "../src/runtime.js";

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
  /** The first N agents started for this step end with a (non-transient) error. */
  errorStarts?: number;
  /** The first N agents started for this step never write a result file. */
  noResultStarts?: number;
  /** The turn takes this many waits to finish (each wait that is not the last times out). */
  finishAfterWaits?: number;
  /** Result of the Nth agent started for this step key (falls back to `result`). */
  resultsByStart?: Array<Record<string, unknown>>;
  /** Files (relative to the repository) the agent writes in its first turn, like a code change. */
  writeFiles?: Record<string, string>;
  /** Files the agent deletes when it gets a follow-up (e.g. fixing what the quality gate found). */
  fixOnFollowUp?: string[];
}

export interface FakeScenario {
  /** Working directory the launching chat reports; defaults to the repository. */
  originCwd?: string;
  /** The launching chat no longer exists. */
  originMissing?: boolean;
  /** Behaviors by step key ("code_review-r2") or step id ("code_review"). */
  steps?: Record<string, FakeBehavior>;
  notifyFails?: boolean;
  /** startSessionAgent throws. */
  sessionFails?: boolean;
  /** Agent profiles the daemon reports; null means they cannot be read. */
  paseoProfiles?: PaseoProfile[] | null;
  /** paseo.json service scripts of the chat's workspace. */
  services?: { names: string[]; failing?: string[]; output?: string };
  quota?: ProviderQuota[] | null;
  activity?: ActivityItem[] | null;
  capabilities?: { paseoTools: boolean; browser: boolean } | null;
  setup?: { status: "completed" | "failed" | "none" | "timeout"; error: string | null };
  /** Paseo cannot schedule (older daemon). */
  noSchedules?: boolean;
  /** Provider login states the daemon reports (default: claude and codex ready); null: unknown. */
  providerStatus?: Array<{ provider: string; status: string }> | null;
  /** Creating the runtime fails, like a daemon that is not running. */
  daemonDown?: boolean;
  /**
   * Agents started by an earlier run (by ID), as attachAgent finds them: "idle" has finished
   * and written its result, "finishes" is still working and finishes at the next wait,
   * "hang" never finishes, "gone" cannot be reached. Unlisted agents are "gone".
   */
  leftovers?: Record<string, "idle" | "finishes" | "hang" | "gone">;
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
  handoff: { status: "done" },
  panel_review: { status: "done" },
  design_proposal: { status: "done" },
  spec_review: { verdict: "issues", issues: ["AC-1.1 没有说明验证码过期后怎么提示"] },
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
  handoff: "handoff.md",
  spec_review: "spec-review.md",
};

function record(event: Record<string, unknown>): void {
  const file = process.env.FAKE_EVENTS;
  if (file) fs.appendFileSync(file, `${JSON.stringify({ ...event, at: Date.now() })}\n`);
}

/** Agents started in any run of this test, so a later run can attach to them. */
function registryFile(): string | null {
  return process.env.FAKE_EVENTS ? `${process.env.FAKE_EVENTS}.agents.json` : null;
}

function readRegistry(): Record<string, { resultAbs: string; result: Record<string, unknown> }> {
  const file = registryFile();
  return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

function contextValue(prompt: string, label: string): string {
  // Only the <pipeline-context> block: prompt text may start a line with the same words.
  const block = prompt.slice(prompt.lastIndexOf("<pipeline-context>"));
  const match = new RegExp(`^${label}：(.+)$`, "m").exec(block);
  if (!match) throw new Error(`prompt is missing "${label}" in <pipeline-context>`);
  return match[1].trim();
}

export const createRuntime: RuntimeFactory = async () => {
  const scenarioFile = process.env.FAKE_SCENARIO;
  const scenario: FakeScenario = scenarioFile ? JSON.parse(fs.readFileSync(scenarioFile, "utf8")) : {};
  if (scenario.daemonDown) throw new Error("connect ECONNREFUSED 127.0.0.1:6767");
  // IDs stay unique across the runs of one test (a resumed run can meet an earlier run's agent).
  let counter = Object.keys(readRegistry()).length;
  let scheduleCounter = 0;
  let worktreeCounter = 0;
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
      // Joint requirements suffix the key with the repository: "implement@backend".
      const bare = key.replace(/@.*$/, "");
      const isProposal = bare.startsWith("design_proposal-");
      const isPanel = !isProposal && /-p\d+$/.test(bare);
      const stepId = isProposal ? "design_proposal" : isPanel ? "panel_review" : bare.replace(/-r\d+$/, "").replace(/-s\d+$/, "");
      const behavior: FakeBehavior = scenario.steps?.[key] ?? scenario.steps?.[stepId] ?? {};
      const resultAbs = path.join(input.cwd, resultRel);
      const startNumber = (startsByKey.get(key) ?? 0) + 1;
      startsByKey.set(key, startNumber);
      const result = behavior.resultsByStart?.[startNumber - 1] ?? behavior.result ?? DEFAULT_RESULTS[stepId];
      const transient = startNumber <= (behavior.transientErrors ?? 0);
      const errored = startNumber <= (behavior.errorStarts ?? 0);
      const noResult = startNumber <= (behavior.noResultStarts ?? 0);
      let waitCount = 0;
      const registry = registryFile();
      if (registry) fs.writeFileSync(registry, JSON.stringify({ ...readRegistry(), [id]: { resultAbs, result } }));

      record({
        type: "start",
        agentId: id,
        key,
        role: input.role,
        provider: input.profile?.provider ?? null,
        modeId: input.profile?.modeId ?? null,
        title: input.title,
        parentAgentId: input.parentAgentId,
        workspaceId: input.workspaceId ?? null,
        cwd: input.cwd,
        labels: input.labels,
        hasSharedContext: input.prompt.includes("# 背景：你在一条需求开发流水线中"),
        hasStepTask: input.prompt.includes("# 本步骤任务"),
        prompt: input.prompt,
      });

      let turn = 0;
      let turnPending = true;
      let permissionWaits = 0;

      const finishTurn = () => {
        if (isProposal) {
          const proposal = path.join(input.cwd, contextValue(input.prompt, "你的提案文件"));
          fs.mkdirSync(path.dirname(proposal), { recursive: true });
          fs.writeFileSync(proposal, `## ${key} 的方案提案（模拟）\n`);
        } else if (isPanel) {
          const findings = path.join(input.cwd, contextValue(input.prompt, "你的意见文件"));
          fs.mkdirSync(path.dirname(findings), { recursive: true });
          fs.appendFileSync(findings, `## ${key} 的意见（模拟评审者）\n`);
        } else {
          const artifact = path.join(input.cwd, featureDir, ARTIFACTS[stepId]);
          fs.appendFileSync(artifact, `\n## ${key}（模拟 agent，第 ${turn + 1} 个回合）\n`);
          fs.appendFileSync(path.join(input.cwd, featureDir, "progress.md"), `- ${key}：完成\n`);
        }
        if (turn === 0 && behavior.writeFiles) {
          for (const [file, content] of Object.entries(behavior.writeFiles)) {
            const abs = path.join(input.cwd, file);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, content);
          }
        }
        if (behavior.neverWritesResult || noResult) return;
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
          if (errored) return { ...base, status: "error", error: "tool crashed: unexpected end of input" };
          waitCount += 1;
          if (behavior.finishAfterWaits && waitCount < behavior.finishAfterWaits) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 50)));
            return { ...base, status: "timeout" };
          }
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
          for (const file of behavior.fixOnFollowUp ?? []) fs.rmSync(path.join(input.cwd, file), { force: true });
        },
        async archive() {
          record({ type: "archive", agentId: id, key });
        },
      };
      return agent;
    },
    attachAgent(agentId) {
      const state = scenario.leftovers?.[agentId] ?? "gone";
      const known = readRegistry()[agentId];
      let waits = 0;
      return {
        id: agentId,
        async wait(timeoutMs): Promise<WaitOutcome> {
          record({ type: "attachWait", agentId, state });
          waits += 1;
          const base = { error: null, lastMessage: "完成", pendingPermissions: [], usage: null };
          if (state === "gone" || !known) throw new Error(`agent ${agentId} not found`);
          if (state === "hang" || (state === "finishes" && waits === 1)) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 50)));
            return { ...base, status: "timeout" };
          }
          if (!fs.existsSync(known.resultAbs)) fs.writeFileSync(known.resultAbs, JSON.stringify(known.result));
          return { ...base, status: "idle" };
        },
        async followUp(text) {
          record({ type: "followUp", agentId, text });
        },
        async archive() {
          record({ type: "archive", agentId });
        },
      };
    },
    async interruptAgent(agentId, text) {
      record({ type: "interrupt", agentId, text });
    },
    async startSessionAgent(input) {
      counter += 1;
      const id = `fake-session-${counter}`;
      record({ type: "startSession", agentId: id, title: input.title, cwd: input.cwd, prompt: input.prompt, labels: input.labels });
      if (scenario.sessionFails) throw new Error("daemon refused");
      return id;
    },
    async notifyAgent(agentId, text) {
      record({ type: "notify", agentId, text });
      if (scenario.notifyFails) throw new Error("agent archived");
    },
    async listPaseoProfiles() {
      return scenario.paseoProfiles === undefined ? [] : scenario.paseoProfiles;
    },
    async listServices(target) {
      record({ type: "listServices", target });
      return scenario.services?.names ?? null;
    },
    async startServices(target, names, readyTimeoutMs) {
      record({ type: "startServices", target, names, readyTimeoutMs });
      return names.map((name, i): ManagedService => {
        const failing = scenario.services?.failing?.includes(name) ?? false;
        return {
          name,
          url: failing ? null : `http://${name}--feature--repo.localhost:6767`,
          port: failing ? null : 41000 + i,
          running: !failing,
          health: failing ? null : "healthy",
          exitCode: failing ? 1 : null,
          output: failing ? (scenario.services?.output ?? "Error: Cannot find module 'express'") : null,
        };
      });
    },
    async stopServices(target, names) {
      record({ type: "stopServices", target, names });
    },
    async createWorktree(request) {
      // Like Paseo: a git worktree on a new branch, outside the source checkout.
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-wt-"));
      fs.rmSync(directory, { recursive: true });
      execFileSync("git", ["worktree", "add", "-q", "-b", request.branchName, directory, request.baseRef], { cwd: request.sourceRepo, stdio: "pipe" });
      worktreeCounter += 1;
      record({ type: "createWorktree", ...request, directory });
      return { workspaceId: `fake-wks-${worktreeCounter}`, directory: fs.realpathSync(directory) };
    },
    async waitForWorkspaceSetup(workspaceId, timeoutMs) {
      record({ type: "waitForWorkspaceSetup", workspaceId, timeoutMs });
      return scenario.setup ?? { status: "completed", error: null };
    },
    async providerQuota(providers) {
      record({ type: "providerQuota", providers });
      return scenario.quota ?? null;
    },
    async recentActivity(agentId, limit) {
      record({ type: "recentActivity", agentId, limit });
      return scenario.activity ?? null;
    },
    async capabilities() {
      return scenario.capabilities ?? null;
    },
    async providerStatus() {
      return scenario.providerStatus === undefined ? [{ provider: "claude", status: "ready" }, { provider: "codex", status: "ready" }] : scenario.providerStatus;
    },
    async scheduleMessage(input) {
      if (scenario.noSchedules) return null;
      scheduleCounter += 1;
      const id = `fake-schedule-${process.pid}-${scheduleCounter}`;
      record({ type: "scheduleMessage", id, agentId: input.agentId, name: input.name, prompt: input.prompt, runAt: input.at?.toISOString() ?? null, cron: input.cron ?? null });
      return id;
    },
    async scheduleNewAgent(input) {
      scheduleCounter += 1;
      const id = `fake-schedule-${process.pid}-${scheduleCounter}`;
      record({ type: "scheduleNewAgent", id, name: input.name, prompt: input.prompt, cron: input.cron, cwd: input.cwd, provider: input.profile.provider ?? null });
      return id;
    },
    async cancelSchedule(id) {
      record({ type: "cancelSchedule", id });
    },
    async close() {
      record({ type: "close" });
    },
  };
  return runtime;
};
