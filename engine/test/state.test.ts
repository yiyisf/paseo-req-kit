import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrateState, readState, STATE_VERSION, StateVersionError } from "../src/state.js";

function tempFile(content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-state-"));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

test("状态文件：当前版本原样读取，不写备份", () => {
  const file = tempFile({ version: STATE_VERSION, status: "failed" });
  const state = readState(file);
  assert.equal(state?.status, "failed");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["state.json"]);
});

test("状态文件：没有 version 字段的旧文件按第 1 版处理", () => {
  const { from } = migrateState({ status: "running" }, "state.json");
  assert.equal(from, 1);
});

test("状态文件：旧版本逐级迁移，写回新格式并保留原文件备份", () => {
  const file = tempFile({ version: 1, status: "failed", stopReason: "x" });
  const migrations = {
    1: (s: Record<string, unknown>) => ({ ...s, milestones: [] }),
    2: (s: Record<string, unknown>) => ({ ...s, renamed: s.stopReason, stopReason: undefined }),
  };
  const state = readState(file, migrations, 3) as unknown as Record<string, unknown>;
  assert.equal(state.version, 3);
  assert.deepEqual(state.milestones, []);
  assert.equal(state.renamed, "x");
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.version, 3);
  const backup = JSON.parse(fs.readFileSync(`${file}.bak-v1`, "utf8"));
  assert.equal(backup.version, 1);
  assert.equal(backup.stopReason, "x");
});

test("状态文件：缺少某一级迁移时报错，不改动文件", () => {
  const file = tempFile({ version: 1 });
  assert.throws(() => readState(file, {}, 2), /缺少 state.json 从第 1 版到第 2 版的迁移/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 1);
});

test("状态文件：比当前版本新（回滚之后）时拒绝，并说明怎么恢复", () => {
  const file = tempFile({ version: STATE_VERSION + 1 });
  assert.throws(() => readState(file), (error: unknown) => {
    assert.ok(error instanceof StateVersionError);
    assert.match(error.message, /请升级 req-kit/);
    assert.match(error.message, /state\.json\.bak-v/);
    return true;
  });
});

test("替换状态文件（1.12.1）：Windows 上文件被短暂占用时重试，别的错误照常抛出", async () => {
  const { replaceFile } = await import("../src/state.js");
  const fsMod = fs;
  const osMod = os;
  const pathMod = path;
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "req-replace-"));
  const file = pathMod.join(dir, "state.json");
  const tmp = `${file}.tmp`;
  fsMod.writeFileSync(tmp, "new");
  const original = fsMod.renameSync;
  let calls = 0;
  (fsMod as { renameSync: typeof fsMod.renameSync }).renameSync = ((a: string, b: string) => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error("locked"), { code: "EPERM" });
    return original(a, b);
  }) as typeof fsMod.renameSync;
  try {
    replaceFile(tmp, file, [1, 1, 1]);
  } finally {
    (fsMod as { renameSync: typeof fsMod.renameSync }).renameSync = original;
  }
  assert.equal(calls, 3);
  assert.equal(fsMod.readFileSync(file, "utf8"), "new");
  assert.throws(() => replaceFile(pathMod.join(dir, "missing.tmp"), file, [1]), /ENOENT/);
});
