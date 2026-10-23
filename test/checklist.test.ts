// The acceptance checklist and trying a finished requirement (1.14).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { acceptanceText, buildChecklist, checklistText, parseCriteria, pipelineResult, verdictOf } from "../engine/src/checklist.js";
import { DEFAULT_CONFIG } from "../engine/src/config.js";
import { registerRequirement, requirementKey } from "../engine/src/records.js";
import { createReviewServer } from "../engine/src/review.js";
import { writeState } from "../engine/src/state.js";
import { howToTry, tryRequirement } from "../engine/src/try.js";

const SPEC = `# 需求说明：订单导出

- 状态：已确认（2026-10-23）
- 版本：2

## 功能需求

### FR-1 导出订单（优先级：必须有）

- **AC-1.1** 导出当前筛选的订单
  - 前置条件：账号 tester01，筛选"已支付"
  - 操作：点"导出"
  - 预期结果：下载 orders.csv，只有已支付的订单
- **AC-1.2** 没有订单时
  - 操作：筛选一个没有订单的日期，点"导出"

  | 筛选 | 结果 |
  | --- | --- |
  | 2020-01-01 | 提示"没有可导出的订单" |

- ~~**AC-1.3** 导出 Excel~~（已取消）

### FR-2 导出记录（优先级：可以以后再说）

- **AC-2.1** 导出后在"导出记录"里能看到这一次
`;

const VERIFICATION = `# 功能验证

| AC | 结果 | 证据 |
| --- | --- | --- |
| AC-1.1 | 通过 | 下载的文件 12 行 |
| AC-1.2 | 未验证 | 测试库里每天都有订单 |
| AC-2.1 | 通过 | 记录页有一条 |

## 第 2 轮

- AC-1.1：复验通过
`;

const REPORT = `# 完成报告

- 结论：已完成，可以验收

## 需要你确认的决定

- 导出的文件名用"orders-日期.csv"
`;

const HANDOFF = `# 提测说明

## 怎么跑起来

npm run dev，打开 http://localhost:3000

## 已知问题和未完成项

- 导出超过 1 万行时较慢

## 测试需要的准备

- 测试账号 tester01，口令在 TEST_PASSWORD
`;

function feature(withState = true) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-check-")));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  const featureDir = "docs/features/20261023-export";
  const dir = path.join(repo, featureDir);
  fs.mkdirSync(path.join(dir, ".pipeline"), { recursive: true });
  for (const [f, t] of [["spec.md", SPEC], ["verification.md", VERIFICATION], ["report.md", REPORT], ["handoff.md", HANDOFF]]) fs.writeFileSync(path.join(dir, f), t);
  if (withState) {
    writeState(path.join(dir, ".pipeline", "state.json"), {
      schema: 1,
      repo,
      featureDir,
      status: "completed",
      originAgentId: "chat-1",
      worktree: { workspaceId: "wks-9", sourceRepo: repo },
      attempt: 1,
      history: [],
      results: {},
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
  }
  registerRequirement({ repo, featureDir, worktree: null } as never);
  return { repo, featureDir, dir, key: requirementKey(repo, featureDir) };
}

test("验收清单：按验收标准生成，带前置条件、操作、例子；取消的不列；没验证的排在前面；报告里要确认的决定也列上", () => {
  const criteria = parseCriteria(SPEC);
  assert.deepEqual(
    criteria.map((c) => [c.id, c.title, c.required]),
    [
      ["AC-1.1", "导出当前筛选的订单", true],
      ["AC-1.2", "没有订单时", true],
      ["AC-2.1", "导出后在\"导出记录\"里能看到这一次", false],
    ],
  );
  assert.deepEqual(criteria[0].details, ['前置条件：账号 tester01，筛选"已支付"', '操作：点"导出"', "预期结果：下载 orders.csv，只有已支付的订单"]);
  assert.ok(criteria[1].details.includes('| 2020-01-01 | 提示"没有可导出的订单" |'));
  assert.equal(pipelineResult("AC-1.1", VERIFICATION).result, "pass");
  assert.equal(pipelineResult("AC-1.2", VERIFICATION).result, "unverified");
  assert.equal(pipelineResult("AC-9.9", VERIFICATION).result, "unknown");
  assert.equal(pipelineResult("AC-1.1", "| AC-1.10 | 失败 |").result, "unknown", "AC-1.1 不匹配 AC-1.10");

  const f = feature();
  const list = buildChecklist(f.dir);
  assert.deepEqual(list.items.map((i) => i.id), ["AC-1.2", "AC-1.1", "AC-2.1", "D-1"]);
  assert.equal(list.items[3].kind, "decision");
  assert.match(list.items[3].title, /orders-日期\.csv/);
  assert.equal(list.reportVerdict, "已完成，可以验收");
  assert.equal(list.specVersion, "2");
  assert.deepEqual(list.notes, ["导出超过 1 万行时较慢", "测试账号 tester01，口令在 TEST_PASSWORD"]);
  const text = checklistText(list, "http://x/check/");
  assert.match(text, /1\. AC-1\.2 没有订单时　\[流水线：没验证\]/);
  assert.match(text, /AC-2\.1 .*（可以以后再说）/);
  assert.match(text, /在验收页上逐条勾选/);

  // The verdict: a failed must-have fails it; "later" items do not; unchecked must-haves block "通过".
  assert.deepEqual(verdictOf(list, [{ id: "AC-1.1", mark: "pass" }]).missing.map((i) => i.id), ["AC-1.2", "D-1"]);
  const ok = verdictOf(list, [{ id: "AC-1.1", mark: "pass" }, { id: "AC-1.2", mark: "pass" }, { id: "AC-2.1", mark: "fail" }, { id: "D-1", mark: "pass" }]);
  assert.equal(ok.verdict, "通过");
  assert.equal(ok.missing.length, 0);
  assert.equal(verdictOf(list, [{ id: "AC-1.2", mark: "fail" }]).verdict, "不通过");

  const record = acceptanceText(list, [{ id: "AC-1.1", mark: "pass" }, { id: "AC-1.2", mark: "fail", note: "提示是空白 | 没字" }], { verdict: "不通过", reviewer: "王五", date: "2026-10-23" });
  assert.match(record, /^# 验收记录：订单导出\n\n- 验收结论：不通过（2026-10-23）\n- 验收人：王五\n- 对照的需求版本：2\n- 对照的报告：report\.md（流水线结论：已完成，可以验收）/);
  assert.match(record, /\| AC-1\.2 \| 不通过 \| 在验收页上亲自核对 \| 提示是空白 \\\| 没字 \|/);
  assert.match(record, /\| D-1 \| 未表态 \|/);
  assert.match(record, /## 不通过的处理\n\n- AC-1\.2：提示是空白 \\\| 没字 → 待和需求方确定处理方式/);
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test("验收清单页：读清单、存草稿、试用；没核对完不能提交通过；不通过时写验收记录、提交、转给需求的对话", async () => {
  const f = feature();
  const calls: string[][] = [];
  const tries: boolean[] = [];
  const server = createReviewServer({
    token: "t",
    readToken: "r",
    run: (c, _r, _f, extra) => (calls.push([c, ...extra]), { ok: true, message: "已转给这个需求的对话。" }),
    tryRun: (_r, _f, stop) => (tries.push(stop), { ok: true, message: "已启动", services: [{ name: "web", url: "http://web.localhost", running: true }] }),
  });
  const base = await listen(server);
  try {
    const page = `${base}/r/t/f/${f.key}/check/`;
    const html = await fetch(page);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /<script src="check\.js"><\/script>/);
    assert.equal((await fetch(`${page}check.js`)).status, 200);
    const info = (await (await fetch(`${page}api/info`)).json()) as { items: Array<{ id: string }>; readOnly: boolean; accepted: string | null };
    assert.deepEqual(info.items.map((i) => i.id), ["AC-1.2", "AC-1.1", "AC-2.1", "D-1"]);
    assert.equal(info.readOnly, false);
    assert.equal(info.accepted, null);
    const ro = (await (await fetch(`${base}/r/r/f/${f.key}/check/api/info`)).json()) as { readOnly: boolean };
    assert.equal(ro.readOnly, true);
    assert.equal((await fetch(`${base}/r/r/f/${f.key}/check/api/submit`, { method: "POST", body: "{}" })).status, 403);

    const put = await fetch(`${page}api/draft`, { method: "PUT", body: JSON.stringify({ answers: [{ id: "AC-1.1", mark: "pass" }], reviewer: "王五" }) });
    assert.equal(put.status, 200);
    assert.deepEqual(((await (await fetch(`${page}api/info`)).json()) as { draft: { answers: unknown[] } }).draft.answers, [{ id: "AC-1.1", mark: "pass" }]);

    const tried = (await (await fetch(`${page}api/try`, { method: "POST", body: "{}" })).json()) as { services: unknown[] };
    assert.equal(tried.services.length, 1);
    assert.deepEqual(tries, [false]);

    const early = await fetch(`${page}api/submit`, { method: "POST", body: JSON.stringify({ answers: [{ id: "AC-1.1", mark: "pass" }] }) });
    assert.equal(early.status, 400);
    assert.match(((await early.json()) as { message: string }).message, /还有 2 条必须验的没有核对（AC-1\.2、D-1）/);

    const failed = await fetch(`${page}api/submit`, { method: "POST", body: JSON.stringify({ answers: [{ id: "AC-1.1", mark: "pass" }, { id: "AC-1.2", mark: "fail", note: "没有提示" }], reviewer: "王五" }) });
    const body = (await failed.json()) as { verdict: string; committed: boolean; message: string };
    assert.equal(body.verdict, "不通过");
    assert.equal(body.committed, true);
    assert.match(body.message, /不对的地方已经转给这个需求的对话/);
    assert.match(fs.readFileSync(path.join(f.dir, "acceptance.md"), "utf8"), /验收结论：不通过/);
    assert.equal(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: f.repo, encoding: "utf8" }).trim(), "docs(20261023-export): 验收记录");
    assert.equal(calls[0][0], "reply");
    assert.equal(calls[0][1], "--acceptance");
    assert.match(calls[0][2], /结论：不通过[\s\S]*- AC-1\.2 没有订单时：没有提示[\s\S]*"验收"手册第 5 步/);
    assert.ok(!fs.existsSync(path.join(f.dir, ".pipeline", "check", "draft.json")), "提交后草稿清掉");

    // Accepted later: the earlier handling notes stay; no message to the chat.
    const before = calls.length;
    const passed = await fetch(`${page}api/submit`, {
      method: "POST",
      body: JSON.stringify({ answers: [{ id: "AC-1.1", mark: "pass" }, { id: "AC-1.2", mark: "pass" }, { id: "D-1", mark: "pass" }] }),
    });
    assert.equal(((await passed.json()) as { verdict: string }).verdict, "通过");
    const accepted = fs.readFileSync(path.join(f.dir, "acceptance.md"), "utf8");
    assert.match(accepted, /验收结论：通过/);
    assert.match(accepted, /验收人：需求方（验收页）/);
    assert.match(accepted, /## 不通过的处理\n\n- AC-1\.2：没有提示/);
    assert.equal(calls.length, before);
  } finally {
    server.close();
  }
});

test("试用：用 Paseo 的服务脚本在需求自己的工作区里启动，给出地址；没有服务脚本时给出启动方法；可以停止", async () => {
  const f = feature();
  const events: string[] = [];
  const runtime = {
    async listServices(target: unknown) {
      events.push(`list ${JSON.stringify(target)}`);
      return ["web", "api"];
    },
    async startServices(_t: unknown, names: string[]) {
      events.push(`start ${names.join(",")}`);
      return names.map((name) => ({ name, url: name === "web" ? "http://web--x.localhost:6767" : null, port: null, running: name === "web", health: null, exitCode: name === "web" ? null : 1, output: name === "web" ? null : "Error: port in use" }));
    },
    async stopServices(_t: unknown, names: string[]) {
      events.push(`stop ${names.join(",")}`);
    },
  };
  const started = await tryRequirement({ repo: f.repo, featureDir: f.featureDir, runtime, config: DEFAULT_CONFIG });
  assert.equal(started.ok, false, "api 没有启动成功");
  assert.match(started.message, /有服务没有启动成功：\n- web：http:\/\/web--x\.localhost:6767\n- api：没有启动成功/);
  assert.equal(started.services[1].output, "Error: port in use");
  assert.deepEqual(events.slice(0, 2), ['list {"workspaceId":"wks-9"}', "start web,api"]);
  assert.match(started.howTo.join("\n"), /怎么跑起来：\n\nnpm run dev[\s\S]*测试需要的准备：[\s\S]*tester01/);

  const stopped = await tryRequirement({ repo: f.repo, featureDir: f.featureDir, stop: true, runtime, config: DEFAULT_CONFIG });
  assert.equal(stopped.stopped, true);
  assert.equal(events.at(-1), "stop web,api");
  assert.equal((await tryRequirement({ repo: f.repo, featureDir: f.featureDir, stop: true, runtime, config: DEFAULT_CONFIG })).stopped, false);

  // No Paseo services: the instructions, and the advice to ask the chat.
  const plain = await tryRequirement({ repo: f.repo, featureDir: f.featureDir, runtime: { ...runtime, listServices: async () => null }, config: DEFAULT_CONFIG });
  assert.equal(plain.ok, false);
  assert.match(plain.message, /没有用 Paseo 管理的服务脚本[\s\S]*帮我把它跑起来/);
  assert.deepEqual(howToTry(f.dir).slice(0, 3), ["怎么跑起来：", "", "npm run dev，打开 http://localhost:3000"]);
});
