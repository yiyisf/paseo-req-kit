import assert from "node:assert/strict";
import { test } from "node:test";
import { describeActivity, summarizeActivity } from "../src/activity.js";
import { findPaseoProfile, profilesFromDaemonConfig, resolveAgentProfile } from "../src/paseo-profiles.js";

const at = (min: number) => new Date(Date.UTC(2026, 9, 13, 10, min)).toISOString();

test("最近活动：工具调用写成白话，忽略思考过程，连续相同的合并，只留最后几条", () => {
  const entries = [
    { timestamp: at(0), item: { type: "reasoning", text: "想一想" } },
    { timestamp: at(1), item: { type: "tool_call", name: "Read", status: "completed", detail: { type: "read", filePath: "/repo/src/auth/login/sms.ts" } } },
    { timestamp: at(2), item: { type: "tool_call", name: "Edit", status: "completed", detail: { type: "edit", filePath: "src/a.ts" } } },
    { timestamp: at(3), item: { type: "tool_call", name: "Bash", status: "failed", detail: { type: "shell", command: "npm   test\n  -- --grep sms" } } },
    { timestamp: at(4), item: { type: "tool_call", name: "Bash", status: "failed", detail: { type: "shell", command: "npm   test\n  -- --grep sms" } } },
    { timestamp: at(5), item: { type: "tool_call", name: "browser_click", status: "completed", detail: { type: "unknown" } } },
    { timestamp: at(6), item: { type: "todo", items: [{ text: "a", completed: true }, { text: "b", completed: false }] } },
    { timestamp: at(7), item: { type: "assistant_message", text: "测试失败，原因是验证码过期时间算错了。" } },
  ];
  const items = summarizeActivity(entries, 5);
  assert.deepEqual(
    items.map((i) => i.text),
    ["修改 src/a.ts", "运行命令：npm test -- --grep sms（失败）", "操作浏览器（click）", "待办清单：完成 1/2", "说明：测试失败，原因是验证码过期时间算错了。"],
  );
  assert.equal(items[1].at, at(4), "合并后取最后一次的时间");
  assert.equal(summarizeActivity(entries, 10)[0].text, "阅读 …/auth/login/sms.ts");
  assert.deepEqual(describeActivity([{ at: at(0), text: "x" }], new Date(Date.UTC(2026, 9, 13, 10, 12))), ["  12 分钟前：x"]);
});

test("Paseo profile 解析：按名称（不区分大小写）或 ID 查找；没有模型时说明原因", () => {
  const list = profilesFromDaemonConfig({
    agentProfiles: [
      { id: "a1", name: "Review", provider: "codex", model: "gpt-x", modeId: "full-access", featureValues: { fast_mode: true } },
      { id: "a2", name: "草稿", provider: "claude" },
      { broken: true },
    ],
  })!;
  assert.equal(list.length, 2);
  assert.equal(findPaseoProfile("review", list)?.id, "a1");
  assert.equal(findPaseoProfile("a2", list)?.name, "草稿");
  assert.deepEqual(resolveAgentProfile("x", { paseoProfile: "Review", featureValues: { other: 1 } }, list), {
    paseoProfile: "Review",
    provider: "codex/gpt-x",
    modeId: "full-access",
    featureValues: { fast_mode: true, other: 1 },
  });
  assert.throws(() => resolveAgentProfile("x", { paseoProfile: "草稿" }, list), /没有选择模型/);
  assert.throws(() => resolveAgentProfile("x", { paseoProfile: "Review" }, null), /无法从 daemon 读取/);
  assert.deepEqual(profilesFromDaemonConfig({}), []);
  assert.deepEqual(resolveAgentProfile("x", { provider: "claude/y" }, null), { provider: "claude/y" });
});
