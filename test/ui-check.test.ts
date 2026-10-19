// req ui-check (1.13): checking a page in words, without looking at it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { check, compareLabels, issueText, pageScript, reportText } from "../engine/src/ui-check.js";

test("界面检查：问题写成人看得懂的话；和原型对文字时忽略空白和冒号", () => {
  const target = { kind: "按钮", text: "导出全部订单", selector: "button", box: { x: 0, y: 0, w: 60, h: 20 } };
  assert.equal(issueText({ kind: "clipped", target, detail: { shown: 60, needed: 120 } }), '文字显示不全：按钮"导出全部订单"（可见宽 60px，需要 120px）');
  assert.equal(
    issueText({ kind: "overlap", target, detail: { other: { ...target, kind: "下拉框", text: "全部" }, area: { w: 10, h: 20 } } }),
    '互相遮挡：按钮"导出全部订单" 和 下拉框"全部" 重叠了 10×20px',
  );
  assert.match(issueText({ kind: "low_contrast", target, detail: { color: "#ccc", background: "#fff", ratio: 1.6, need: 3 } }), /对比度 1\.6:1，至少要 3:1/);
  assert.deepEqual(compareLabels(["状态：", "查 询", "下单时间"], ["状态", "查询", "导出"]), { missing: ["下单时间"], extra: ["导出"] });
  // The in-page script is one function expression (what browser_evaluate takes).
  assert.match(pageScript(), /^\(function reqKitUiCheck\(input\) \{[\s\S]*\}\)$/);
  const { text, problems } = reportText({ url: "http://x/", widths: [{ width: 390, findings: { width: 390, height: 800, title: "t", issues: [], labels: [] }, console: [], failedRequests: [], screenshot: null }], prototype: null });
  assert.equal(problems, 0);
  assert.match(text, /## 手机宽度 390px：http:\/\/x\//);
  assert.match(text, /结论：没有发现问题。/);
});

const playwrightDir = ["/opt/node-tools/node_modules/playwright-core"].find((p) => fs.existsSync(p));
const browserPath = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => fs.existsSync(p));

test("界面检查（浏览器）：找出显示不全、超出屏幕、文字太淡、没名字的控件、报错；和原型对文字", { skip: !playwrightDir || !browserPath ? "这台机器没有 playwright-core 和 Chromium" : false }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-ui-home-"));
  fs.mkdirSync(path.join(home, "tools", "node_modules"), { recursive: true });
  fs.symlinkSync(playwrightDir!, path.join(home, "tools", "node_modules", "playwright-core"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-ui-"));
  fs.writeFileSync(
    path.join(dir, "page.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>订单列表</title><style>
      body{margin:0;padding:16px;font-family:sans-serif} .name{width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block}
      .pale{color:#ddd} .wide{width:1500px;height:10px} .btn{background:#1677ff;color:#fff;border:0;padding:8px 14px}</style></head>
    <body><h1>订单列表</h1><label>状态</label><select><option>全部</option></select><button class="btn">查询</button><input id="kw">
    <span class="name">一个特别特别长的客户名称</span><p class="pale">已取消的订单不显示</p><div class="wide"></div>
    <button><svg width="10" height="10"></svg></button><script>console.error("boom")</script></body></html>`,
  );
  fs.writeFileSync(
    path.join(dir, "proto.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>订单列表</title></head><body><h1>订单列表</h1>
    <section data-state="正常"><div data-ac="AC-1.1"><label>状态</label><select><option>全部</option></select><button>查询</button><button>重置</button></div></section>
    <section data-state="空数据"><p data-ac="AC-1.2">暂无订单</p></section><script>document.title = "x"</script></body></html>`,
  );
  const report = await check({
    url: pathToFileURL(path.join(dir, "page.html")).href,
    widths: [1280, 390],
    prototype: path.join(dir, "proto.html"),
    state: "正常",
    steps: [],
    shots: path.join(dir, "shots"),
    browser: browserPath!,
    env: { ...process.env, REQ_KIT_HOME: home },
  });
  const [desk, phone] = report.widths;
  const kinds = (w: typeof desk) => w.findings.issues.map((i) => i.kind).sort();
  assert.deepEqual(kinds(desk), ["clipped", "low_contrast", "no_label", "no_name", "overflow"]);
  assert.ok(kinds(phone).includes("small_target"));
  assert.deepEqual(desk.console, ["boom"]);
  assert.ok(fs.existsSync(path.join(dir, "shots", "page-1280.png")));
  // "状态" is right before the select: it counts as its label; the input has none.
  assert.equal(desk.findings.issues.find((i) => i.kind === "no_label")?.target?.selector, "#kw");
  // The prototype's "重置" button is missing; the "空数据" state is not compared.
  assert.deepEqual(report.prototype?.missing, ["重置"]);
  const { text, problems } = reportText(report);
  assert.ok(problems > 5);
  assert.match(text, /原型里有、页面上没有（1）："重置"/);
  assert.match(text, /文字太淡看不清：文字"已取消的订单不显示"/);
});
