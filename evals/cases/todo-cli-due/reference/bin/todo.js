#!/usr/bin/env node
import { add, done, formatTask, isValidDate, list, UsageError } from "../src/commands.js";

function run(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case "add": {
      const at = rest.indexOf("--due");
      let due = null;
      if (at !== -1) {
        due = rest[at + 1] ?? "";
        if (!isValidDate(due)) throw new UsageError("截止日期格式应为 YYYY-MM-DD");
        rest.splice(at, 2);
      }
      const task = add(rest.join(" "), due);
      console.log(task.id);
      return;
    }
    case "list": {
      for (const task of list({ all: rest.includes("--all"), overdue: rest.includes("--overdue") })) console.log(formatTask(task));
      return;
    }
    case "done": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) throw new UsageError("请给出任务编号，例如 todo done 2");
      done(id);
      return;
    }
    default:
      throw new UsageError("用法：todo add <内容> [--due YYYY-MM-DD] | todo list [--all | --overdue] | todo done <编号>");
  }
}

try {
  run(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`错误：${error.message}`);
    process.exit(1);
  }
  throw error;
}
