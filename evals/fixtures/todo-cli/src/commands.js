import { load, save } from "./store.js";

export class UsageError extends Error {}

export function add(title) {
  if (!title || !title.trim()) throw new UsageError("任务内容不能为空");
  const data = load();
  const task = { id: data.nextId, title: title.trim(), done: false };
  data.tasks.push(task);
  data.nextId += 1;
  save(data);
  return task;
}

export function list({ all = false } = {}) {
  return load().tasks.filter((t) => all || !t.done);
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
  return `${task.id}. [${task.done ? "x" : " "}] ${task.title}`;
}
