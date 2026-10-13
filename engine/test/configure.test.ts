import assert from "node:assert/strict";
import { test } from "node:test";
import { type Catalog, type Chooser, profileFor, runWizard, unattendedMode } from "../src/configure.js";

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
