import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const CLI = path.resolve(import.meta.dirname, "..", "bin", "todo.js");

function todo(file, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, TODO_FILE: file } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "todo-")), "todo.json");
}

test("add, list, done", () => {
  const file = tempFile();
  assert.equal(todo(file, "add", "写周报").out, "1");
  assert.equal(todo(file, "add", "交报销").out, "2");
  assert.equal(todo(file, "done", "1").code, 0);
  assert.equal(todo(file, "list").out, "2. [ ] 交报销");
  assert.equal(todo(file, "list", "--all").out, "1. [x] 写周报\n2. [ ] 交报销");
});

test("errors", () => {
  const file = tempFile();
  const empty = todo(file, "add", "  ");
  assert.equal(empty.code, 1);
  assert.match(empty.err, /^错误：任务内容不能为空/);
  assert.match(todo(file, "done", "9").err, /^错误：找不到编号为 9 的任务/);
});
