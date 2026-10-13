import { load, save } from "./store.js";

export class UsageError extends Error {}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(text) {
  const m = DATE.exec(text ?? "");
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

export function today() {
  const fromEnv = process.env.TODO_TODAY;
  if (fromEnv) return fromEnv;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function add(title, due = null) {
  if (!title || !title.trim()) throw new UsageError("任务内容不能为空");
  if (due !== null && !isValidDate(due)) throw new UsageError("截止日期格式应为 YYYY-MM-DD");
  const data = load();
  const task = { id: data.nextId, title: title.trim(), done: false, ...(due ? { due } : {}) };
  data.tasks.push(task);
  data.nextId += 1;
  save(data);
  return task;
}

export function list({ all = false, overdue = false } = {}) {
  const now = today();
  return load().tasks.filter((t) => (overdue ? !t.done && t.due && t.due < now : all || !t.done));
}

export function done(id) {
  const data = load();
  const task = data.tasks.find((t) => t.id === id);
  if (!task) throw new UsageError(`找不到编号为 ${id} 的任务`);
  task.done = true;
  save(data);
  return task;
}

export function formatTask(task) {
  return `${task.id}. [${task.done ? "x" : " "}] ${task.title}${task.due ? `（截止 ${task.due}）` : ""}`;
}
