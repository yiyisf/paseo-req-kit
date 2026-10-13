# todo-cli

命令行待办工具。数据保存在 `TODO_FILE` 环境变量指定的 JSON 文件中（默认 `~/.todo.json`）。

```bash
node bin/todo.js add "写周报"        # 添加，输出新任务的编号
node bin/todo.js list               # 列出未完成的任务
node bin/todo.js list --all         # 列出全部任务
node bin/todo.js done 2             # 把 2 号任务标为完成
```

- 运行测试：`npm test`（即 `node --test test/*.test.js`，只依赖 Node.js 22）
- 出错时向 stderr 输出一行以"错误："开头的中文说明，退出码为 1
