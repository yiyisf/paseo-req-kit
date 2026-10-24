// 1.14: the background check reminds a chat once when its confirmed requirement never started;
// a requirement in two places is listed once.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type ListItem, onePerRequirement } from "../src/api.js";
import { registerRequirement } from "../src/records.js";
import { watchdogPass } from "../src/watchdog.js";

test("确认了却没开始的需求：30 分钟后提醒它的对话一次；还在对齐、已经开发、太久以前的不提醒", () => {
  process.env.REQ_KIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-wd-home-"));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-wd-")));
  const make = (name: string, status: string, extra: Record<string, string> = {}, ageMinutes = 45) => {
    const fd = `docs/features/${name}`;
    fs.mkdirSync(path.join(repo, fd), { recursive: true });
    const spec = path.join(repo, fd, "spec.md");
    fs.writeFileSync(spec, `# ${name}\n\n- 状态：${status}\n`);
    for (const [f, c] of Object.entries(extra)) fs.writeFileSync(path.join(repo, fd, f), c);
    const t = new Date(Date.now() - ageMinutes * 60_000);
    fs.utimesSync(spec, t, t);
    registerRequirement({ repo, featureDir: fd, worktree: null } as never, process.env, `chat-${name}`);
    return fd;
  };
  const target = make("a-confirmed", "已确认（2026-10-24）");
  make("b-draft", "草稿");
  make("c-developed", "已确认（2026-10-24）", { "implementation.md": "# 实现\n" });
  make("d-fresh", "已确认（2026-10-24）", {}, 10);
  make("e-old", "已确认（2026-10-01）", {}, 60 * 24 * 10);
  const sent: string[] = [];
  const remind = (_r: string, f: string) => (sent.push(f), { ok: true, message: "已转给这个需求的对话。" });
  const first = watchdogPass({ by: "plugin", resume: () => ({ ok: true, message: "" }), remind });
  assert.deepEqual(sent, [target]);
  assert.deepEqual(first.reminded.map((r) => r.featureDir), [target]);
  watchdogPass({ by: "plugin", resume: () => ({ ok: true, message: "" }), remind });
  assert.deepEqual(sent, [target], "只提醒一次");
});

test("同一个需求在两处：列出有运行状态的那一份", () => {
  const base = { key: "k", project: "p", featureDir: "docs/features/x", name: "x", title: "x", running: false, present: true } as unknown as ListItem;
  const main = { ...base, repo: "/main", status: null, updatedAt: "2026-10-24T10:00:00Z" } as ListItem;
  const wt = { ...base, repo: "/wt", status: "completed", updatedAt: "2026-10-24T09:00:00Z" } as ListItem;
  const other = { ...base, key: "o", repo: "/main", status: null, updatedAt: "2026-10-24T08:00:00Z" } as ListItem;
  assert.deepEqual(onePerRequirement([main, wt, other]).map((x) => x.repo + x.key), ["/wtk", "/maino"]);
});
