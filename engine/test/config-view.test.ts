// 1.12: `req api config` — every setting in words, where it comes from, secrets never shown.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configView, masked } from "../src/config-view.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

test("配置展示：分组列出全部设置，用大白话写值；标出来自本机、团队还是项目；改过的标出来；密钥和个人账号不显示", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "req-config-view-"));
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "team.json"), JSON.stringify({ watchdogMinutes: 30, notifiers: [{ module: "/x/im.mjs", options: { webhook: "https://secret.example/hook", group: "dev" } }], people: { 张三: { um: "U1" } } }));
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ ...base, teamConfig: "team.json", agents: { builder: { provider: "claude/opus", modeId: "bypassPermissions" }, reviewer: { provider: "codex/gpt", modeId: "full-access" }, fallback: { provider: "opencode/x" } } }),
  );
  const repo = path.join(dir, "shop");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, ".requirement-pipeline.json"), JSON.stringify({ defaultProfile: "quick", daemonUrl: "ws://evil", checks: [{ name: "测试", command: "npm test" }] }));

  const view = configView(path.join(dir, "config.json"), repo);
  assert.equal(view.error, null);
  assert.deepEqual(view.sources.map((s) => s.layer), ["machine", "team", "project"]);
  assert.ok(view.ignored.some((i) => /项目配置中的 daemonUrl/.test(i)));
  const items = Object.fromEntries(view.groups.flatMap((g) => g.items).map((i) => [i.key, i]));
  assert.deepEqual(view.groups.map((g) => g.title).slice(0, 3), ["模型与评审", "流程", "质量"]);

  assert.match(items.agents.display, /builder：claude\/opus（模式 bypassPermissions）；reviewer：codex\/gpt（模式 full-access）；备用模型：opencode\/x/);
  assert.equal(items.defaultProfile.display, "快速档");
  assert.deepEqual(items.defaultProfile.setBy, ["machine", "project"]);
  assert.equal(items.defaultProfile.changed, true);
  assert.deepEqual(items.watchdogMinutes.setBy, ["machine", "team"]);
  assert.equal(items.watchdogMinutes.display, "每 30 分钟");
  assert.deepEqual(items.daemonUrl.setBy, ["machine"], "项目中的 daemonUrl 不算");
  assert.equal(items.daemonUrl.scope, "machine");
  assert.equal(items.notifiers.scope, "machine_team");
  assert.equal(items.selfHeal.changed, false, "和默认值一样");
  assert.match(items.checks.display, /测试（npm test）/);

  const shown = JSON.stringify(view);
  assert.ok(!shown.includes("secret.example"), "webhook 不显示");
  assert.ok(!shown.includes("U1"), "个人账号不显示");
  assert.equal(items.people.display, "1 人");
  assert.deepEqual(masked({ token: "abc", nested: [{ apiKey: "k", name: "n" }] }), { token: "••••", nested: [{ apiKey: "••••", name: "n" }] });
});

test("配置展示：配置有错误时照样列出各文件写的值，并说明错误", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "req-config-view-bad-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ agents: { builder: { provider: "claude/CHANGE-ME" }, reviewer: { provider: "codex/CHANGE-ME" } }, selfHeal: "yes" }));
  const view = configView(path.join(dir, "config.json"), null);
  assert.match(view.error ?? "", /示例值|selfHeal/);
  const items = Object.fromEntries(view.groups.flatMap((g) => g.items).map((i) => [i.key, i]));
  assert.ok(items.agents);
});
