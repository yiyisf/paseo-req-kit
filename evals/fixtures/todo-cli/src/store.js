import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function storePath() {
  return process.env.TODO_FILE || path.join(os.homedir(), ".todo.json");
}

export function load() {
  const file = storePath();
  if (!fs.existsSync(file)) return { nextId: 1, tasks: [] };
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function save(data) {
  fs.writeFileSync(storePath(), `${JSON.stringify(data, null, 2)}\n`);
}
