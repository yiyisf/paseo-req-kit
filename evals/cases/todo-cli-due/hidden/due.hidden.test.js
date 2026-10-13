import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const CLI = path.resolve(import.meta.dirname, "..", "bin", "todo.js");

function todo(file, today, ...args) {
  const env = { ...process.env, TODO_FILE: file };
  if (today) env.TODO_TODAY = today;
  else delete env.TODO_TODAY;
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const temp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "todo-hidden-")), "todo.json");

test("FR-1 add with --due, before or after the title", () => {
  const file = temp();
  assert.equal(todo(file, null, "add", "写周报", "--due", "2026-10-20").out, "1");
  assert.equal(todo(file, null, "add", "--due", "2026-10-22", "交", "报销").out, "2");
  assert.equal(todo(file, null, "add", "买咖啡").out, "3");
  assert.equal(
    todo(file, null, "list").out,
    "1. [ ] 写周报（截止 2026-10-20）\n2. [ ] 交 报销（截止 2026-10-22）\n3. [ ] 买咖啡",
  );
});

test("FR-1 invalid dates are rejected and nothing is saved", () => {
  const file = temp();
  for (const bad of [["--due", "2026-13-01"], ["--due", "2026-02-30"], ["--due", "明天"], ["--due"]]) {
    const r = todo(file, null, "add", "写周报", ...bad);
    assert.equal(r.code, 1, bad.join(" "));
    assert.match(r.err, /^错误：截止日期格式应为 YYYY-MM-DD/, bad.join(" "));
  }
  assert.equal(todo(file, null, "list", "--all").out, "");
});

test("FR-2 list --all shows due dates", () => {
  const file = temp();
  todo(file, null, "add", "写周报", "--due", "2026-10-20");
  todo(file, null, "done", "1");
  assert.equal(todo(file, null, "list", "--all").out, "1. [x] 写周报（截止 2026-10-20）");
});

test("FR-3 overdue filter", () => {
  const file = temp();
  todo(file, null, "add", "昨天到期", "--due", "2026-10-20");
  todo(file, null, "add", "今天到期", "--due", "2026-10-21");
  todo(file, null, "add", "已完成", "--due", "2026-10-01");
  todo(file, null, "add", "没有期限");
  todo(file, null, "done", "3");
  assert.equal(todo(file, "2026-10-21", "list", "--overdue").out, "1. [ ] 昨天到期（截止 2026-10-20）");
  const none = todo(file, "2026-10-01", "list", "--overdue");
  assert.equal(none.code, 0);
  assert.equal(none.out, "");
});

test("FR-3 without TODO_TODAY uses the local date", () => {
  const file = temp();
  todo(file, null, "add", "很久以前", "--due", "2000-01-01");
  todo(file, null, "add", "很久以后", "--due", "2999-01-01");
  assert.equal(todo(file, null, "list", "--overdue").out, "1. [ ] 很久以前（截止 2000-01-01）");
});

test("FR-4 old data files still work", () => {
  const file = temp();
  fs.writeFileSync(file, JSON.stringify({ nextId: 3, tasks: [{ id: 1, title: "旧任务", done: false }, { id: 2, title: "旧的已完成", done: true }] }));
  assert.equal(todo(file, "2026-10-21", "list", "--overdue").out, "");
  assert.equal(todo(file, null, "list").out, "1. [ ] 旧任务");
  assert.equal(todo(file, null, "done", "1").code, 0);
});
