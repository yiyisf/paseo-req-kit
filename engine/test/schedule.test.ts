import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { digestText } from "../src/digest.js";
import type { FeatureSummary } from "../src/features.js";
import { slotHolders, tryAcquireSlot } from "../src/queue.js";
import { cronAt, cronEvery, parseStartTime } from "../src/schedule-time.js";

test("开始时间：今天/明天的钟点、完整日期、相对时间；看不懂的返回 null", () => {
  const now = new Date(2026, 9, 13, 20, 15);
  assert.deepEqual(parseStartTime("22:00", now), new Date(2026, 9, 13, 22, 0));
  assert.deepEqual(parseStartTime("8:30", now), new Date(2026, 9, 14, 8, 30), "已经过了的钟点是明天");
  assert.deepEqual(parseStartTime("明天 9:05", now), new Date(2026, 9, 14, 9, 5));
  assert.deepEqual(parseStartTime("2026-10-20 07:00", now), new Date(2026, 9, 20, 7, 0));
  assert.deepEqual(parseStartTime("+2h", now), new Date(2026, 9, 13, 22, 15));
  assert.deepEqual(parseStartTime("+90m", now), new Date(2026, 9, 13, 21, 45));
  assert.equal(parseStartTime("下午三点", now), null);
  assert.equal(parseStartTime("25:00", now), null);
  assert.equal(cronAt(new Date(2026, 9, 14, 8, 30)), "30 8 14 10 *");
  assert.equal(cronEvery(30), "*/30 * * * *");
  assert.equal(cronEvery(120), "0 */2 * * *");
});

test("并发上限：名额用完时拿不到；释放或持有者进程不在了就空出来", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-slots-"));
  const holder = (pid: number) => ({ pid, repo: "/r", featureDir: "docs/features/a", since: "now" });
  const first = tryAcquireSlot(dir, 1, holder(process.ppid));
  assert.ok(first);
  assert.equal(tryAcquireSlot(dir, 1, holder(process.pid)), null);
  assert.equal(slotHolders(dir).length, 1);
  first();
  const second = tryAcquireSlot(dir, 1, holder(process.pid));
  assert.ok(second);
  second();
  fs.writeFileSync(path.join(dir, "slot-0.json"), JSON.stringify(holder(2 ** 22 + 12345)));
  assert.ok(tryAcquireSlot(dir, 1, holder(process.pid)), "进程已不在的名额可以回收");
});

test("需求总览：按需要处理、待验收、开发中等分组，已验收只列最近的", () => {
  const now = new Date("2026-10-13T10:00:00Z");
  const f = (name: string, stage: string, updatedAt: string): FeatureSummary => ({
    name,
    featureDir: `docs/features/${name}`,
    worktree: "/r",
    branch: `feature/${name}`,
    developed: true,
    title: name.toUpperCase(),
    type: null,
    specVersion: 1,
    confirmed: true,
    profile: "standard",
    stage,
    updatedAt,
    usage: null,
  });
  const text = digestText("shop", [
    f("a", "等待需求方决定", "2026-10-12T00:00:00Z"),
    f("b", "待验收", "2026-10-12T00:00:00Z"),
    f("c", "已验收", "2026-09-01T00:00:00Z"),
    f("d", "已验收", "2026-10-11T00:00:00Z"),
    f("e", "开发中", "2026-10-13T00:00:00Z"),
  ], now);
  assert.match(text, /共 5 个需求：需要处理 1，待验收 1，开发中 1，已验收 2；最近 7 天有变化的 4 个/);
  assert.match(text, /需要处理：\n- A（a）：等待需求方决定/);
  assert.match(text, /已验收（最近 7 天）：\n- D（d）/);
  assert.doesNotMatch(text, /C（c）/);
  assert.match(digestText("shop", [], now), /还没有需求/);
});
