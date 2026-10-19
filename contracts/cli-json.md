# 给程序用的 JSON 输出：`req api`

1.9.0 起。Paseo 插件和其他程序通过 `req api` 读取需求、执行管理操作，不直接读写状态文件。每个命令输出一行 JSON：

```json
{ "schema": 1, "kitVersion": "1.9.0", "data": … }
```

出错时退出码为 1：

```json
{ "schema": 1, "kitVersion": "1.9.0", "error": { "code": "not_found", "message": "没有找到需求……" } }
```

`code`：`bad_arguments`（参数不对）、`not_found`（目录或需求不存在）、`not_allowed`（不允许的文件或命令）、`failed`（其他错误）。

`schema` 只在不兼容的修改时增加；新增字段不改变 `schema`，读取方应忽略不认识的字段。

## 命令

| 命令 | `data` |
| --- | --- |
| `req api version` | `{ kitVersion, kitRoot, apiSchema, paseo, featuresDir }`：`paseo` 是这个版本支持的 Paseo 范围 |
| `req api list [--repo <目录>]` | 这个仓库所有工作区中的需求，数组，每项见下面的"需求" |
| `req api list --all` | 本机记录过的所有需求（[需求索引](usage-record.md)），同上；目录已不在的 `present: false` |
| `req api status <需求> [--repo <目录>]` | 一个需求的详情，见下面的"详情" |
| `req api file <需求> <文件> [--repo <目录>]` | `{ featureDir, file, size, truncated, content }`；只能读取功能目录中的文档（见下），最多 512 KB |
| `req api stats [--since 30d] [--month 2026-10]` | `req stats --json` 的内容，见 [使用记录](usage-record.md) |
| `req api index [--rebuild <目录>…] [--prune]` | 不带选项：索引的全部条目；`--rebuild`：`{ scanned, registered, pruned, total }` |
| `req api run <approve\|stop\|resume\|verify\|sync\|reply> <需求> [--repo <目录>] [选项]` | `{ command, featureDir, ok, exitCode, message }`。在 `--repo`（默认当前目录）中执行与 `req <命令> <需求>` 完全相同的操作；`ok` 为 false 时退出码为 1 |
| `req api models` | 1.12 起。`{ current, choices, recommended }`：本机配置中现在的 `agents`；daemon 上能无人值守运行的选择（`{ id, label, provider, profile }`，Paseo profile 在前）；按推荐的 `agents`。连不上 daemon 时报错 |
| `req api config [--repo <目录>] [--machine]` | 1.12 起。`{ sources, ignored, error, repo, groups }`：`sources` 是生效的配置文件（`layer` 为 `machine` / `team` / `project`，按叠加顺序）；`groups` 按主题分组，每项 `{ key, label, description, display, value, setBy, scope, changed }`：`display` 是用大白话写的值，`value` 中看起来像密钥的值和个人账号替换为 `••••`，`setBy` 是写了它的文件，`changed` 表示与默认值不同。配置有错误时 `error` 写明原因，值按各文件所写。`--machine` 不看项目配置 |
| `req api set-agents --json <设置>` | 1.12 起。`{ ok, message }`。`<设置>` 是 `{ builder, reviewer, fallback }`（`fallback` 可以为 null），检查后写入本机配置的 `agents`，原文件备份 |
| `req api review-url <需求> [--repo <目录>] [--read-only]` | 1.13 起。`{ url, readOnly }`：这个需求的原型审查页地址（需要时在后台启动审查页的服务）。`--read-only` 的地址只能看，不能提交意见或确认方案。需求不在本机的需求索引中或还没有 `prototype/` 时报 `not_found` |

`<需求>` 的写法与 `req status` 相同：功能目录、目录名或名称中能唯一确定的一部分。需求在为它新建的工作区中开发时，`--repo` 写对话所在的目录或那个工作区都可以。

`req api file` 能读取的文件：`spec.md`、`alignment.md`、`spec-review.md`、`changes.md`、`decisions.tsv`、`design.md`、`design-review.md`、`preview.md`、`contract.md`、`diagnosis.md`、`assessment.md`、`implementation.md`、`progress.md`、`code-review.md`、`handoff.md`、`service-start.md`、`verification.md`、`report.md`、`acceptance.md`、`lessons.tsv`。

## 需求（`list` 的每一项）

| 字段 | 含义 |
| --- | --- |
| `key` | 需求在本机的标识（对话所在目录 + 功能目录） |
| `project` | 项目名：对话所在目录的目录名 |
| `repo` | 需求所在的目录（有自己的工作区时是那个工作区） |
| `sourceRepo` / `workspaceId` | 有自己的工作区时：对话所在的目录、Paseo 工作区 ID；否则 null |
| `featureDir` / `name` / `title` | 功能目录、目录名、需求标题 |
| `type` / `profile` / `branch` | 需求类型（`defect`、`refactor`、`assessment` 或 null）、档位、分支 |
| `stage` | 与 `req list` 相同的阶段说明，如"开发中""等待确认方案""待验收" |
| `status` | 状态文件的 `status`；还没运行过为 null |
| `running` | 后台进程是否在运行 |
| `phase` | `develop` / `verify` |
| `attention` | 需要人处理的事：`approval`（确认方案）、`business`（需求方决定）、`interrupted`（中断，可以继续）、`not_completed`（结束但未完成）；没有为 null |
| `waiting` | 1.12 起。`attention` 不为 null 时：`since`（从什么时候开始等）、`questions`（需求方要回答的问题）、`reason`（停止原因）、`card`（`{ system, id, url, requester }`，从卡片开始的需求）、`canReply`（能否用 `req api run reply <需求> <回复>` 把回复转给需求的对话）；否则为 null |
| `current` | 正在运行的步骤 `[{ key, title, agentId }]` |
| `updatedAt` | 最近一次变化的时间 |
| `usage` | `{ steps, agentMinutes, inputTokens, outputTokens, costUsd }`；没运行过为 null |
| `present` | 目录是否还在 |
| `hasPrototype` | 1.13 起。功能目录中有界面原型（`prototype/`），可以用原型审查页查看 |

## 详情（`status`）

"需求"的全部字段，另加：

| 字段 | 含义 |
| --- | --- |
| `files` | 功能目录中存在的、可以用 `req api file` 读取的文件 |
| `run` | `{ attempt, startedAt, updatedAt, pid, phaseMode, stopReason, outcome, queuedSince, verifyAt, approval, originAgentId }`；没运行过为 null |
| `steps` | 每个步骤一项：`{ key, stepId, title, phase, attempt, round, agentId, startedAt, endedAt, minutes, outcome, result, error, usage }`；`title` 是给人看的名称（如"代码评审（第 2 轮）"），`result` 是结论的文字（如"需要修改"） |
| `gate` | 质量门：状态文件中的 `gate` |
| `joint` | 联合需求的其他仓库：`[{ name, slug, repo, sourceRepo, branch, workspaceId, gate }]` |
| `external` | 外部系统中的卡片（1.9.0 起）：`[{ name, id, url, status, syncedAt, pending, lastError }]`；`pending` 是等待补发的调用数 |
