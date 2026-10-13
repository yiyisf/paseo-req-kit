import assert from "node:assert/strict";
import { test } from "node:test";
import { describeTotals, totals } from "../src/usage.js";

test("用量汇总：累加各步骤；没有报告用量时如实说明", () => {
  const t = totals([
    { attempt: 1, startedAt: "2026-10-13T10:00:00Z", endedAt: "2026-10-13T10:30:00Z", usage: { inputTokens: 800_000, outputTokens: 50_000, totalCostUsd: 2.5 } },
    { attempt: 1, startedAt: "2026-10-13T10:30:00Z", endedAt: "2026-10-13T12:05:00Z", usage: { inputTokens: 400_000, outputTokens: 33_000 } },
  ]);
  assert.equal(t.steps, 2);
  assert.equal(Math.round(t.agentMinutes), 125);
  assert.equal(describeTotals(t), "2 个步骤，agent 合计用时 2 小时 5 分；输入 120 万 tokens，输出 8.3 万 tokens，约 $2.50");
  const none = totals([{ attempt: 1, startedAt: "2026-10-13T10:00:00Z", endedAt: "2026-10-13T10:00:20Z" }]);
  assert.equal(describeTotals(none), "1 个步骤，agent 合计用时 不到 1 分钟；agent 没有报告 token 用量");
});
