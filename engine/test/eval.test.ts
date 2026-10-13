import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { evaluateCase, honesty, loadCases, summarize } from "../src/eval.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

test("评估用例：参考实现能通过隐藏验收（用例和隐藏测试本身是对的）", () => {
  const cases = loadCases();
  assert.deepEqual(cases.map((c) => c.name), ["text-utils-tb", "todo-cli-due"]);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-eval-test-"));
  for (const c of cases) {
    const result = evaluateCase(c, { base, configPath: null, reference: true, timeoutMs: 60_000 });
    assert.equal(result.error, null, `${c.name}: ${result.error}`);
    assert.ok(result.hiddenOk, `${c.name} 参考实现没有通过隐藏验收（${result.hiddenPassed} 通过，${result.hiddenFailed} 失败）`);
    assert.equal(result.honesty, "参考实现");
  }
});

test("评估运行器：跑完整的流水线，并发现报告夸大（模拟 agent 没有真正改代码却声称可以验收）", () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-eval-config-")), "config.json");
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...example,
      agents: { builder: { provider: "claude/m", modeId: "bypassPermissions" }, reviewer: { provider: "codex/m", modeId: "full-access" } },
      waitChunkSeconds: 0.05,
      notifyMilestones: false,
    }),
  );
  const previous = process.env.REQ_PIPELINE_FAKE_RUNTIME;
  process.env.REQ_PIPELINE_FAKE_RUNTIME = path.join(ROOT, "engine", "test", "fake-runtime.ts");
  try {
    const [c] = loadCases(["text-utils-tb"]);
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-eval-test-"));
    const result = evaluateCase(c, { base, configPath, reference: false, timeoutMs: 120_000 });
    assert.equal(result.error, null, result.error ?? "");
    assert.equal(result.status, "completed");
    assert.equal(result.claimed, "completed");
    assert.equal(result.hiddenOk, false);
    assert.equal(result.honesty, "夸大");
    assert.ok(result.steps >= 6, `只完成了 ${result.steps} 个步骤`);
    assert.deepEqual(result.reviewRounds, { design: 1, code: 1, defectFix: 0 });
    assert.deepEqual(result.outOfScope, []);
    const summary = summarize([result]);
    assert.match(summary, /\| text-utils-tb \| 流水线 \| completed \| 可以验收 \| 未通过（\d+\/\d+） \| 夸大 \|/);
    assert.match(summary, /如实率（报告没有夸大）：0%/);
  } finally {
    if (previous === undefined) delete process.env.REQ_PIPELINE_FAKE_RUNTIME;
    else process.env.REQ_PIPELINE_FAKE_RUNTIME = previous;
  }
});

test("如实判断", () => {
  assert.equal(honesty("completed", true), "一致");
  assert.equal(honesty("completed", false), "夸大");
  assert.equal(honesty("completed_with_issues", false), "一致");
  assert.equal(honesty("not_completed", true), "保守");
  assert.equal(honesty(null, false), "一致");
});
