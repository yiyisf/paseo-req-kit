// Tests the real Paseo adapter against a fake SDK client that places agents the
// way the 0.11 daemon does: with a parent, the parent's cwd wins over the requested cwd.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { createRuntimeWithClient, samePath, type SdkClient } from "../src/paseo-runtime.js";

interface CreateCall {
  cwd: string;
  parent?: string;
  config?: Record<string, unknown>;
}

function fakeClient(agentCwds: Record<string, string>) {
  const created: Array<CreateCall & { id: string; actualCwd: string }> = [];
  const archived: string[] = [];
  const handle = (id: string, cwd: string | null) => ({
    id,
    refresh: async () => (cwd === null ? null : { agent: { id, cwd }, project: null }),
    archive: async () => {
      archived.push(id);
      return { archivedAt: "now" };
    },
    send: async () => undefined,
    waitForFinish: async () => ({ status: "idle", final: null, error: null, lastMessage: null }),
  });
  const client = {
    agents: {
      ref: (id: string) => handle(id, agentCwds[id] ?? null),
      create: async (options: CreateCall) => {
        const id = `agent-${created.length + 1}`;
        // Daemon placement rule (create-agent/intent.ts): caller's cwd when a parent is given.
        const actualCwd = options.parent ? agentCwds[options.parent] : options.cwd;
        created.push({ id, cwd: options.cwd, parent: options.parent, config: options.config, actualCwd });
        agentCwds[id] = actualCwd;
        return handle(id, actualCwd);
      },
    },
    close: async () => undefined,
  };
  return { client: client as unknown as SdkClient, created, archived };
}

const input = (parentAgentId: string | null) => ({
  role: "builder" as const,
  title: "[x] 3-方案设计",
  prompt: "p",
  cwd: "/work/pipeline-smoke-test",
  labels: {},
  parentAgentId,
});

test("发起对话的目录就是仓库目录：校验通过，步骤 agent 挂在对话下", async () => {
  const fake = fakeClient({ chat: "/work/pipeline-smoke-test" });
  const runtime = createRuntimeWithClient(fake.client, DEFAULT_CONFIG, () => undefined);
  await runtime.verifyOrigin("chat", "/work/pipeline-smoke-test");
  await runtime.startAgent(input("chat"));
  assert.equal(fake.created[0].parent, "chat");
  assert.equal(fake.created[0].actualCwd, "/work/pipeline-smoke-test");
});

test("发起对话在别的目录：拒绝启动并说明原因（回归：结果文件不存在）", async () => {
  const fake = fakeClient({ chat: "/work/ai-coding-tools" });
  const runtime = createRuntimeWithClient(fake.client, DEFAULT_CONFIG, () => undefined);
  await assert.rejects(
    runtime.verifyOrigin("chat", "/work/pipeline-smoke-test"),
    /发起对话的工作目录是 \/work\/ai-coding-tools，与仓库目录 \/work\/pipeline-smoke-test 不一致/,
  );
  assert.equal(fake.created.length, 0);
});

test("找不到发起对话：拒绝启动", async () => {
  const fake = fakeClient({});
  const runtime = createRuntimeWithClient(fake.client, DEFAULT_CONFIG, () => undefined);
  await assert.rejects(runtime.verifyOrigin("gone", "/work/pipeline-smoke-test"), /找不到发起对话的 agent gone/);
});

test("步骤 agent 一律挂在发起对话下；实际目录不对时停止它并报错", async () => {
  const fake = fakeClient({ chat: "/work/ai-coding-tools" });
  const runtime = createRuntimeWithClient(fake.client, DEFAULT_CONFIG, () => undefined);
  // Even if verifyOrigin was skipped, the daemon's placement is caught after creation.
  await assert.rejects(runtime.startAgent(input("chat")), /工作目录是 \/work\/ai-coding-tools，不是仓库目录/);
  assert.equal(fake.created[0].parent, "chat");
  assert.deepEqual(fake.archived, ["agent-1"]);
});

test("路径比较：Windows 下不区分大小写和结尾分隔符", () => {
  assert.ok(samePath("D:\\Users\\Me\\Repo\\", "d:\\users\\me\\repo", "win32"));
  assert.ok(!samePath("/a/Repo", "/a/repo", "linux"));
  assert.ok(samePath("/a/repo/", "/a/repo", "linux"));
});

test("Pi：provider 写成 pi/<上游>/<模型>，不传 modeId", async () => {
  const fake = fakeClient({ chat: "/work/pipeline-smoke-test" });
  const config = {
    ...DEFAULT_CONFIG,
    agents: {
      builder: { provider: "pi/anthropic/claude-sonnet-5", thinkingOptionId: "high" },
      reviewer: { provider: "pi/openai/gpt-5.5" },
    },
  };
  const runtime = createRuntimeWithClient(fake.client, config, () => undefined);
  await runtime.startAgent(input("chat"));
  await runtime.startAgent({ ...input("chat"), role: "reviewer" });
  assert.deepEqual(fake.created[0].config, { provider: "pi/anthropic/claude-sonnet-5", thinkingOptionId: "high" });
  assert.deepEqual(fake.created[1].config, { provider: "pi/openai/gpt-5.5" });
});

test("OpenCode：modeId 为 build，并通过 featureValues 开启自动批准", async () => {
  const fake = fakeClient({ chat: "/work/pipeline-smoke-test" });
  const config = {
    ...DEFAULT_CONFIG,
    agents: {
      builder: { provider: "opencode/anthropic/claude-sonnet-5", modeId: "build", featureValues: { auto_accept: true } },
      reviewer: { provider: "claude/claude-sonnet-5", modeId: "bypassPermissions" },
    },
  };
  const runtime = createRuntimeWithClient(fake.client, config, () => undefined);
  await runtime.startAgent(input("chat"));
  assert.deepEqual(fake.created[0].config, {
    provider: "opencode/anthropic/claude-sonnet-5",
    modeId: "build",
    featureValues: { auto_accept: true },
  });
});


test("连接 Paseo（1.12.1）：连不上时到时放弃并关闭客户端，不留下后台重连的连接", async () => {
  const { connectWithin } = await import("../src/paseo-runtime.js");
  let closed = 0;
  const never = { connect: () => new Promise(() => undefined), close: async () => void (closed += 1) };
  await assert.rejects(connectWithin(never, 30, "ws://127.0.0.1:6767/ws"), /秒内没有连上 Paseo（ws:\/\/127\.0\.0\.1:6767\/ws）/);
  assert.equal(closed, 1);
  const ok = { connect: async () => undefined, close: async () => void (closed += 1) };
  await connectWithin(ok, 30, "x");
  assert.equal(closed, 1, "连上时不关闭");
});
