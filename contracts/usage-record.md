# 本机的需求索引与使用记录

1.9.0 起，引擎在本机配置目录（默认 `~/.req-kit`，可用 `REQ_KIT_HOME` 改变）下记两样东西。它们只在这台机器上，不提交进任何仓库，也不会自动发往任何地方。环境变量 `REQ_KIT_NO_RECORD=1` 时两样都不记（评估运行就是这样）。

## 需求索引 `index/<key>.json`

每个在本机运行过的需求一个文件，记录它在哪里，供 `req api list --all` 和 Paseo 插件找到本机所有的需求。需求的阶段、进度仍然现场从功能目录读取（ADR 0010）。

```json
{
  "schema": 1,
  "key": "3f2a9c1e5b7d4e8a",
  "repo": "/home/me/work/shop-sms-login",
  "featureDir": "docs/features/20261012-sms-login",
  "sourceRepo": "/home/me/work/shop",
  "workspaceId": "ws_123",
  "project": "shop",
  "registeredAt": "2026-10-12T09:00:00.000Z"
}
```

`key` 由对话所在的目录（没有自己的工作区时即 `repo`）和功能目录算出。1.14 起：开始谈需求时（`start-pipeline --feature <功能目录> --track`）就登记，此时多一个可选字段 `chatAgentId`（谈需求的对话），之后的登记保留它；新建需求自己的工作区时，条目改为指向那个工作区。目录里有 `spec.md`、`alignment.md` 或 `.pipeline/` 下的状态或登记标记时算作存在。

## 新建工作区的记录 `worktrees/<key>.json`（1.14）

用 `--worktree` 启动时，工作区一建好就写下：`{ schema, sourceRepo, featureDir, repo, workspaceId, branch, baseRef, createdAt, originAgentId }`。之后的启动失败了，再次启动时在这个工作区里接着做，不再新建；插件据此把"工作区已建、开发没开始"的需求列进"等你处理"。`req index --rebuild` 为 1.9 之前运行过的需求补登，`req index --prune` 移除目录已不在的。

## 使用记录 `usage/runs.jsonl`

每次流水线运行（后台进程从开始到结束，包括停在等待确认、等待需求方、研发完成处）结束时追加一行：

| 字段 | 含义 |
| --- | --- |
| `schema` / `kind` | `1` / `"run"` |
| `machine` / `kitVersion` | 主机名、req-kit 版本 |
| `requirement` | `{ key, project, name, title, type, profile }`；从卡片开始的需求（1.10 起）另有 `requester`（卡片的提出人）和 `source`（`{ system, id }`） |
| `steps[].cachedInputTokens` / `steps[].agent` | 1.13 起。输入中来自提示缓存的 tokens（agent 报告时）；这一步用的 agent（Paseo profile 名，或 "provider/model"）。更早的记录没有 |
| `run` | `{ startedAt, endedAt, attempt, phase, phaseMode, status, outcome, stopReason, stopKind, recoveries }`；`status` 是运行结束时的状态，`outcome` 是完成时报告的结论；`stopKind`（1.12 起）是停下等人的原因代码（见 [state.md](state.md)），`recoveries`（1.12 起）是这次运行中自动处理的次数，按种类，如 `{ "retry": 2 }`。更早的记录没有这两项 |
| `agents` | `{ builder, reviewer }`：当时配置的 agent（如 `claude/opus（bypassPermissions）`） |
| `steps` | 这次运行中开始的步骤：`{ key, stepId, phase, attempt, round, startedAt, endedAt, minutes, outcome, inputTokens, outputTokens, costUsd }`；agent 没有报告的用量为 null |
| `gate` | `{ runs, failed }`：这次运行中质量门运行的次数、发现新失败的次数 |

不记录需求内容、代码和对话。

## 统计口径（`req stats`）

- 一段时间的用量、步骤用时：结束时间在这段时间内的运行。
- 交付周期：需求第一次开始到完成（最后一次运行以"已完成"结束）的小时数，用这个需求的全部运行，算在完成的那段时间。
- 代码评审轮数、缺陷修复轮数：不同的（尝试、轮次、仓库）个数；评审分方向或评审小组的几个成员算一轮。
- 等待：相邻两次运行之间的间隔，按前一次结束时的状态归类：等待确认方案、等待需求方决定、研发完成到开始测试验证、中断到继续。
- token 花在哪（1.13 起，`tokens`）：这段时间的步骤按 `stepId`、按 `agent` 合计 token（输入 + 输出）和占比；返工（`design_revise`、`review_fix`、`defect_fix`、`reverify`，以及 `design_review`、`code_review` 第 2 轮起）的合计和占比；报告了 `cachedInputTokens` 的，算出输入中来自提示缓存的比例；已完成需求的 token 中位数（按档位）。
- 停下等人的原因（1.12 起）：这段时间结束的运行按 `stopKind` 计数；更早的记录按结束时的状态推断。确认方案、研发完成等待测试是必要的决定。
- 无人工到提测的比例（1.12 起）：这段时间有进展、已经研发完成或完成的需求中，所有运行都只停在必要决定处的比例。
- 自动处理的比例（1.12 起）：自动处理的次数 ÷（自动处理的次数 + 以中断结束的运行数）；需求方决定、缺陷复现不了不算中断。
- 合并多台机器的导出时，同一机器、同一需求、同一开始时间的运行只算一次。

`req stats --json` 和 `req api stats` 输出同样的对象（`schema: 1`）：`period`、`machines`、`active`、`completed`、`byType`、`cycleHours`、`steps`、`rework`、`waits`、`usage`、`byBuilder`、`requirements`（每个需求一项，字段与 `req stats --csv` 的列对应）。
