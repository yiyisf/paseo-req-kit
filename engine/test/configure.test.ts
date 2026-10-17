import assert from "node:assert/strict";
import { test } from "node:test";
import { agentChoices, applyAgents, type Catalog, type Chooser, profileFor, recommended, recommendFallback, runWizard, unattendedMode } from "../src/configure.js";

const catalog: Catalog = {
  async providers() {
    return [
      { id: "claude", status: "ready" },
      { id: "codex", status: "ready" },
      { id: "pi", status: "ready" },
      { id: "gemini", status: "error" },
    ];
  },
  async models(provider) {
    return { claude: [{ id: "claude-x", label: "Claude X" }], codex: [{ id: "gpt-x" }], pi: [{ id: "anthropic/claude-x" }] }[provider] ?? [];
  },
  async modes(provider) {
    return {
      claude: [{ id: "default" }, { id: "bypassPermissions" }],
      codex: [{ id: "read-only" }, { id: "full-access" }],
      pi: [],
    }[provider] ?? [];
  },
};

/** Answers with the recommended option, and records the questions and options it saw. */
function recorder(): { choose: Chooser; seen: Array<{ question: string; options: string[] }> } {
  const seen: Array<{ question: string; options: string[] }> = [];
  const choose: Chooser = async (question, options) => {
    seen.push({ question, options: options.map((o) => o.label) });
    return options[0].value;
  };
  return { choose, seen };
}

test("配置向导：只列可用的 agent，自动选免确认模式，reviewer 优先推荐不同的 agent，保留其他设置", async () => {
  const { choose, seen } = recorder();
  const { config, summary } = await runWizard({ daemonUrl: "ws://x", stepTimeoutMinutes: { implement: 300 } }, catalog, choose);
  assert.deepEqual(config.agents, {
    builder: { provider: "claude/claude-x", modeId: "bypassPermissions" },
    reviewer: { provider: "codex/gpt-x", modeId: "full-access" },
    fallback: { provider: "pi/anthropic/claude-x" },
  });
  assert.equal(config.daemonUrl, "ws://x");
  assert.deepEqual(config.stepTimeoutMinutes, { implement: 300 });
  assert.equal(config.defaultProfile, "standard");
  assert.ok(!seen[0].options.some((o) => o.includes("gemini")), "不可用的 agent 不应列出");
  assert.equal(seen[2].options[0], "codex", "reviewer 应优先推荐与 builder 不同的 agent");
  assert.match(seen[1].options[0], /Claude X（claude-x）/);
  assert.match(summary.join("\n"), /builder：claude\/claude-x（模式 bypassPermissions）/);
});

test("免确认模式：各 agent 的推荐；没有模式的 agent 不写 modeId；OpenCode 自动接受权限", () => {
  assert.equal(unattendedMode("claude", [{ id: "default" }, { id: "bypassPermissions" }]), "bypassPermissions");
  assert.equal(unattendedMode("codex", [{ id: "full-access" }]), "full-access");
  assert.equal(unattendedMode("pi", []), null);
  assert.equal(unattendedMode("claude", [{ id: "default" }]), null);
  assert.deepEqual(profileFor("pi", "anthropic/claude-x", null), { provider: "pi/anthropic/claude-x" });
  assert.deepEqual(profileFor("opencode", "openai/gpt-x", "build"), {
    provider: "opencode/openai/gpt-x",
    modeId: "build",
    featureValues: { auto_accept: true },
  });
});

test("配置向导：找不到免确认模式时请用户选择", async () => {
  const restricted: Catalog = { ...catalog, modes: async () => [{ id: "ask" }, { id: "auto" }] };
  const answers: string[] = [];
  const choose: Chooser = async (question, options) => {
    answers.push(question);
    return options.at(-1)!.value;
  };
  const { config } = await runWizard({}, restricted, choose);
  assert.ok(answers.some((q) => q.includes("没有找到") && q.includes("免确认模式")));
  assert.equal((config.agents as { builder: { modeId: string } }).builder.modeId, "auto");
});

test("配置向导：Paseo 中有 agent profile 时先推荐 profile（按名称和说明匹配角色），选中后写 paseoProfile", async () => {
  const withProfiles: Catalog = {
    ...catalog,
    profiles: async () => [
      { id: "1", name: "草稿", provider: "claude" },
      { id: "2", name: "评审", provider: "codex", model: "gpt-x", modeId: "full-access", notes: "独立 review" },
      { id: "3", name: "实现", provider: "claude", model: "claude-x", modeId: "bypassPermissions" },
    ],
  };
  const { choose, seen } = recorder();
  const { config, summary } = await runWizard({}, withProfiles, choose);
  assert.deepEqual(config.agents, { builder: { paseoProfile: "实现" }, reviewer: { paseoProfile: "评审" }, fallback: { provider: "pi/anthropic/claude-x" } });
  assert.ok(!seen[0].options.some((o) => o.includes("草稿")), "没有模型的 profile 不列出");
  assert.match(seen[0].options.at(-1) ?? "", /不用 profile/);
  assert.match(summary.join("\n"), /builder：Paseo profile「实现」/);
});

test("自动选择（1.12）：不提问，两个不同厂商分别做 builder 和 reviewer，第三个厂商做备用；只有一种 agent 时两者相同并说明", async () => {
  const { config, summary } = await runWizard({}, catalog, recommended);
  assert.equal((config.agents as { builder: { provider: string } }).builder.provider, "claude/claude-x");
  assert.equal((config.agents as { reviewer: { provider: string } }).reviewer.provider, "codex/gpt-x");
  assert.match(summary.join("\n"), /备用模型：pi\/anthropic\/claude-x/);

  const single: Catalog = { ...catalog, providers: async () => [{ id: "claude", status: "ready" }] };
  const one = await runWizard({}, single, recommended);
  assert.deepEqual(Object.keys(one.config.agents as object), ["builder", "reviewer"]);
  assert.match(one.summary.join("\n"), /只有一种 agent 可用，评审用同一个/);
  assert.match(one.summary.join("\n"), /备用模型：不用/);

  // A provider whose modes all ask for approval is not offered.
  const asking: Catalog = { ...catalog, modes: async (p) => (p === "codex" ? [{ id: "read-only" }] : catalog.modes(p)) };
  assert.ok(!(await agentChoices(asking)).some((c) => c.provider === "codex"));
  const choices = await agentChoices(catalog);
  assert.equal(recommendFallback(choices, "claude", "claude"), choices.find((c) => c.provider === "codex"));
  assert.equal(recommendFallback(choices.filter((c) => c.provider === "claude"), "claude", "claude"), null);
});

test("插件设置页写回的 agent（1.12）：检查后写入，其余设置保留；不合格的拒绝", () => {
  const existing = { daemonUrl: "ws://x", agents: { builder: { provider: "a/b" }, reviewer: { provider: "c/d" }, fallback: { provider: "e/f" } } };
  const next = applyAgents(existing, { builder: { provider: "claude/x", modeId: "bypassPermissions" }, reviewer: { paseoProfile: "评审" }, fallback: null });
  assert.deepEqual(next, { daemonUrl: "ws://x", agents: { builder: { provider: "claude/x", modeId: "bypassPermissions" }, reviewer: { paseoProfile: "评审" } } });
  assert.throws(() => applyAgents(existing, { builder: { provider: "claude/CHANGE-ME" }, reviewer: { provider: "c/d" } }), /都要选/);
  assert.throws(() => applyAgents(existing, { builder: { provider: "a/b" }, reviewer: { provider: "c/d" }, fallback: { provider: "x" } }), /备用模型/);
});
