// The prototype review page (1.13): engine/src/review.ts and its page.
import assert from "node:assert/strict";
import fs from "node:fs";
import type http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { registerRequirement, requirementKey } from "../engine/src/records.js";
import { type ReviewComment, composeFeedback, createReviewServer, dirHash, prototypeFiles, snapshotVersion, specCriteria } from "../engine/src/review.js";
import { writeState } from "../engine/src/state.js";

const PROTOTYPE = `<!doctype html><html><head><meta charset="utf-8"><title>订单列表</title>
<style>body{font-family:sans-serif;margin:0;padding:24px} .btn{background:#1677ff;color:#fff;padding:6px 12px;border:0}</style></head>
<body>
  <h1>订单列表</h1>
  <section data-state="正常">
    <div data-ac="AC-1.1" data-label="新的筛选栏"><label>状态</label><select><option>全部</option></select><button class="btn" id="search">查询</button></div>
    <table><tr><th>订单号</th><th>金额</th></tr><tr><td>A001</td><td>12.00</td></tr></table>
  </section>
  <section data-state="空数据">
    <p data-ac="AC-1.2" data-label="列表为空时的提示">没有数据</p>
  </section>
  <script>window.parent.document.title = "pwned"; fetch("api/submit", {method: "POST", body: JSON.stringify({action: "approve"})});</script>
</body></html>`;

function feature() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-review-repo-")));
  const featureDir = "docs/features/20261019-order-filter";
  const dir = path.join(repo, featureDir);
  fs.mkdirSync(path.join(dir, "prototype"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "spec.md"),
    "# 需求说明：订单列表增加状态筛选\n\n## 验收标准\n\n- **AC-1.1**：列表上方有状态筛选，选择后点查询只显示该状态的订单\n- AC-1.2 没有订单时显示“暂无订单”的提示\n- 见 AC-1.1 的例子\n",
  );
  fs.writeFileSync(path.join(dir, "prototype", "list.html"), PROTOTYPE);
  fs.mkdirSync(path.join(dir, ".pipeline"), { recursive: true });
  writeState(path.join(dir, ".pipeline", "state.json"), {
    schema: 1,
    repo,
    featureDir,
    status: "waiting_for_approval",
    originAgentId: "agent-chat-1",
    attempt: 1,
    history: [],
    results: {},
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  registerRequirement({ repo, featureDir, worktree: null } as never);
  return { repo, featureDir, dir, key: requirementKey(repo, featureDir) };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test("原型审查：读出验收标准、原型页面和版本；同一版本不重复保存，改过后能找到上一版", () => {
  assert.deepEqual(specCriteria("- **AC-1.1**：列表上方有状态筛选\n- AC-1.2 没有订单时显示提示\n- 再提一次 AC-1.1\n| AC-2 | 表格里的 |"), [
    { id: "AC-1.1", text: "列表上方有状态筛选" },
    { id: "AC-1.2", text: "没有订单时显示提示" },
    { id: "AC-2", text: "表格里的" },
  ]);
  const f = feature();
  assert.deepEqual(prototypeFiles(path.join(f.dir, "prototype")), [{ path: "list.html", title: "订单列表" }]);
  const review = path.join(f.dir, ".pipeline", "review");
  const first = snapshotVersion(path.join(f.dir, "prototype"), review);
  assert.equal(first.current, dirHash(path.join(f.dir, "prototype")));
  assert.equal(first.previous, null);
  assert.deepEqual(snapshotVersion(path.join(f.dir, "prototype"), review), first);
  fs.writeFileSync(path.join(f.dir, "prototype", "list.html"), PROTOTYPE.replace("没有数据", "暂无订单"));
  const second = snapshotVersion(path.join(f.dir, "prototype"), review);
  assert.equal(second.previous, first.current);
  assert.notEqual(second.current, first.current);
  assert.ok(fs.readFileSync(path.join(review, "versions", first.current!, "list.html"), "utf8").includes("没有数据"));
});

test("原型审查：意见整理成需求会话能直接用的文字（位置、点的是什么、要改成什么）", () => {
  const comments: ReviewComment[] = [
    {
      id: "a",
      file: "list.html",
      state: "空数据",
      width: 390,
      kind: "text",
      newText: "暂无订单，点右上角新建",
      target: { desc: "文字", text: "没有数据", region: { ac: "AC-1.2", label: "列表为空时的提示", index: 2 }, styles: { color: "#333333", fontSize: "14px", size: "80×20" } },
    },
    {
      id: "b",
      file: "list.html",
      state: "正常",
      width: 1280,
      kind: "color",
      note: "和旁边的取消按钮一样用灰色",
      target: { desc: "按钮", text: "查询", styles: { color: "#ffffff", background: "#1677ff", fontSize: "14px", size: "60×30" } },
    },
  ];
  const text = composeFeedback(comments, "整体再紧凑一点");
  assert.match(text, /共 2 条，另有总体意见/);
  assert.match(text, /总体意见：整体再紧凑一点/);
  assert.match(text, /1\. 位置：原型 list\.html，状态"空数据"，手机宽度 390px，区域 2「列表为空时的提示」（AC-1\.2）/);
  assert.match(text, /要改：文字改为"暂无订单，点右上角新建"（原来是"没有数据"）/);
  assert.match(text, /点的是：按钮"查询"（文字颜色 #ffffff，背景 #1677ff，字号 14px，大小 60×30）/);
  assert.match(text, /要改：换颜色\n {3}说明：和旁边的取消按钮一样用灰色/);
  const long = composeFeedback(Array.from({ length: 80 }, (_, i) => ({ ...comments[1], id: String(i), note: "很长的说明".repeat(30) })), "");
  assert.ok(long.length < 7700);
  assert.match(long, /意见太长，后面的没有转达/);
});

test("原型审查：没有令牌打不开；原型里的脚本不能运行；草稿保存；提交意见转给需求会话、确认方案", async () => {
  const f = feature();
  const calls: Array<[string, string, string, string[]]> = [];
  const server = createReviewServer({
    token: "full-token",
    readToken: "read-token",
    run: (command, repo, featureDir, extra) => {
      calls.push([command, repo, featureDir, extra]);
      return { ok: true, message: command === "approve" ? "已确认" : "已转给这个需求的对话" };
    },
  });
  const base = await listen(server);
  try {
    assert.equal((await fetch(`${base}/r/wrong/f/${f.key}/`)).status, 403);
    assert.equal((await fetch(`${base}/x`)).status, 404);
    assert.equal((await fetch(`${base}/r/full-token/f/nope/api/info`)).status, 404);
    const redirect = await fetch(`${base}/r/full-token/f/${f.key}`, { redirect: "manual" });
    assert.equal(redirect.status, 301);
    const page = await fetch(`${base}/r/full-token/f/${f.key}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /原型审查/);
    // Paseo's web UI on this machine may embed the page.
    assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'self' http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\*/);

    const info = await (await fetch(`${base}/r/full-token/f/${f.key}/api/info`)).json();
    assert.equal(info.title, "订单列表增加状态筛选");
    assert.equal(info.waitingForApproval, true);
    assert.equal(info.canReply, true);
    assert.equal(info.readOnly, false);
    assert.deepEqual(info.files, [{ path: "list.html", title: "订单列表" }]);
    assert.deepEqual(info.criteria.map((c: { id: string }) => c.id), ["AC-1.1", "AC-1.2"]);

    const proto = await fetch(`${base}/r/full-token/f/${f.key}/proto/cur/list.html`);
    assert.match(proto.headers.get("content-security-policy") ?? "", /script-src 'none'/);
    assert.equal((await fetch(`${base}/r/full-token/f/${f.key}/proto/cur/..%2F..%2Fspec.md`)).status, 404);
    assert.equal((await fetch(`${base}/r/full-token/f/${f.key}/proto/cur/../spec.md`)).status, 404);

    const put = await fetch(`${base}/r/full-token/f/${f.key}/api/draft`, { method: "PUT", body: JSON.stringify({ comments: [{ id: "x", kind: "remove", file: "list.html" }], general: "g" }) });
    assert.equal(put.status, 200);
    assert.equal((await (await fetch(`${base}/r/full-token/f/${f.key}/api/draft`)).json()).comments.length, 1);
    // The read-only link can look but not change anything.
    assert.equal((await fetch(`${base}/r/read-token/f/${f.key}/api/draft`, { method: "PUT", body: "{}" })).status, 403);
    assert.equal((await fetch(`${base}/r/read-token/f/${f.key}/api/submit`, { method: "POST", body: JSON.stringify({ action: "approve" }) })).status, 403);
    assert.equal((await (await fetch(`${base}/r/read-token/f/${f.key}/api/info`)).json()).readOnly, true);

    const empty = await fetch(`${base}/r/full-token/f/${f.key}/api/submit`, { method: "POST", body: JSON.stringify({ action: "changes", comments: [] }) });
    assert.equal(empty.status, 400);
    const sent = await fetch(`${base}/r/full-token/f/${f.key}/api/submit`, {
      method: "POST",
      body: JSON.stringify({ action: "changes", comments: [{ id: "a", file: "list.html", kind: "remove", target: { desc: "按钮", text: "查询" } }], general: "" }),
    });
    assert.equal(sent.status, 200);
    assert.equal(calls[0][0], "reply");
    assert.equal(calls[0][1], f.repo);
    assert.equal(calls[0][2], f.featureDir);
    assert.match(calls[0][3][0], /要改：删掉/);
    // Sent: the draft is gone, a record of what was sent stays.
    assert.ok(!fs.existsSync(path.join(f.dir, ".pipeline", "review", "draft.json")));
    assert.equal(fs.readdirSync(path.join(f.dir, ".pipeline", "review", "submitted")).length, 1);

    const ok = await fetch(`${base}/r/full-token/f/${f.key}/api/submit`, { method: "POST", body: JSON.stringify({ action: "approve" }) });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls[1], ["approve", f.repo, f.featureDir, []]);
  } finally {
    server.close();
  }
});

/** playwright-core when it is installed somewhere on this machine (not in CI): the page in a real browser. */
function playwright(): { chromium: { launch(o: object): Promise<any> } } | null {
  const candidates = [process.env.REQ_KIT_TEST_PLAYWRIGHT, "/opt/node-tools/node_modules/playwright-core", "playwright-core"].filter(Boolean) as string[];
  const require = createRequire(import.meta.url);
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* next */
    }
  }
  return null;
}
const browserPath = ["/opt/pw-browsers/chromium/chrome-linux/chrome", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => fs.existsSync(p));
const pw = playwright();

test("原型审查页（浏览器）：标出要看的地方、切换状态、点选留意见、双击改字、提交", { skip: !pw || !browserPath ? "这台机器没有 playwright-core 和 Chromium" : false }, async () => {
  const f = feature();
  const calls: string[][] = [];
  const server = createReviewServer({ token: "t", readToken: "r", run: (c, _r, _f, extra) => (calls.push([c, ...extra]), { ok: true, message: "ok" }) });
  const base = await listen(server);
  const browser = await pw!.chromium.launch({ executablePath: browserPath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    page.on("dialog", (d: { accept(): Promise<void> }) => d.accept());
    await page.goto(`${base}/r/t/f/${f.key}/`);
    await page.waitForSelector("#regions li .badge");
    assert.equal(await page.textContent("#title"), "订单列表增加状态筛选");
    assert.equal(await page.textContent("#status"), "等你确认方案");
    // The prototype's own script did not run.
    assert.equal(await page.title(), "原型审查 · 订单列表增加状态筛选");
    // Regions of the current state, with their criteria.
    assert.match(await page.textContent("#regions"), /新的筛选栏[\s\S]*AC-1\.1：列表上方有状态筛选/);
    const frame = page.frameLocator("#frame");
    assert.equal(await frame.locator(".rk-badge").count(), 1);
    // Switch to the empty state.
    await page.click('#states button:has-text("空数据")');
    await page.waitForFunction(() => document.querySelector("#regions")?.textContent?.includes("列表为空时的提示"));

    // Click an element, pick "change color", say why.
    await page.click('#states button:has-text("正常")');
    await frame.locator("#search").click();
    await page.waitForSelector("#pop:not([hidden])");
    assert.match(await page.textContent("#popTitle"), /按钮“查询”/);
    assert.match(await page.textContent("#popSub"), /区域 ①「新的筛选栏」（AC-1\.1）/);
    await page.click('#kinds button:has-text("换颜色")');
    await page.fill("#note", "和取消按钮一样用灰色");
    await page.click("#popOk");
    await frame.locator(".rk-pin").first().waitFor();
    assert.match(await page.textContent("#comments"), /换颜色[\s\S]*按钮“查询”[\s\S]*和取消按钮一样用灰色/);

    // Double-click a text and type the new one.
    await page.click('#states button:has-text("空数据")');
    const tip = frame.locator('p[data-ac="AC-1.2"]');
    await tip.dblclick();
    await page.keyboard.type("暂无订单");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll("#comments li").length === 2);
    assert.match(await page.textContent("#comments"), /文字改成“暂无订单”/);
    // Saved as a draft.
    await page.waitForFunction(() => document.querySelector("#saved")?.textContent?.includes("已自动保存"));
    const draft = JSON.parse(fs.readFileSync(path.join(f.dir, ".pipeline", "review", "draft.json"), "utf8"));
    assert.equal(draft.comments.length, 2);
    assert.equal(draft.comments[1].target.text, "没有数据");
    assert.equal(draft.comments[1].state, "空数据");

    await page.click("#submitChanges");
    await page.waitForFunction(() => document.querySelector("#result")?.textContent?.includes("已转给需求会话"));
    assert.equal(calls[0][0], "reply");
    assert.match(calls[0][1], /文字改为"暂无订单"（原来是"没有数据"）/);
    assert.match(calls[0][1], /点的是：按钮"查询"（文字颜色 #ffffff，背景 #1677ff/);
    assert.deepEqual(errors, []);

    // A revised prototype: the page offers what changed.
    fs.writeFileSync(path.join(f.dir, "prototype", "list.html"), PROTOTYPE.replace("没有数据", "暂无订单").replace("<th>金额</th>", "<th>金额</th><th>下单时间</th>"));
    await page.reload();
    await page.waitForSelector("#changesCard:not([hidden])");
    await page.waitForFunction(() => document.querySelector("#changes")?.textContent?.includes("共 1 处"));
    assert.equal(await frame.locator(".rk-changed").count(), 1);
    assert.equal(await frame.locator(".rk-changed").textContent(), "下单时间");
  } finally {
    await browser.close();
    server.close();
  }
});
