# state.json

流水线的运行状态，位于 `docs/features/<目录>/.pipeline/state.json`，只由引擎写入，不提交。

## 当前格式：version 1

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `version` | number | 格式版本。没有这个字段的文件按 1 处理 |
| `repo` | string | 仓库目录（绝对路径） |
| `featureDir` | string | 功能目录（相对路径，`/` 分隔） |
| `status` | `running` \| `waiting_for_business` \| `failed` \| `completed` | 当前状态。`waiting_for_business` 表示等待需求方决定 |
| `attempt` | number | 第几次从方案设计开始 |
| `specHash` | string | 启动时 spec.md 的 sha256 |
| `originAgentId` | string \| null | 发起对话的 agent，通知发往这里 |
| `pid` | number | 流水线进程 |
| `startedAt` / `updatedAt` | ISO 时间 | |
| `results` | object | 已完成步骤的结果，键为步骤键（如 `code_review-r2`） |
| `history` | array | 每次步骤执行的记录：agent、起止时间、结果、错误；`usage`（可选，1.3.0 起）为 agent 报告的用量：`inputTokens`、`cachedInputTokens`、`outputTokens`、`totalCostUsd`，agent 没有报告时为 null 或缺少 |
| `stopReason` / `outcome` | string \| null | 停止原因；最终结论 |
| `profile` | `quick` \| `standard` | 档位 |
| `branch` | string \| null | 工作分支，启动时确定 |
| `milestones` | string[] | 已发送的进展通知，续跑时不重复发送 |
| `incremental` | object \| null | 可选，1.3.0 起。需求变更或回答问题后的继续：`fromAttempt`（接着哪一次）、`reason`、`baseCommit`（本次开始时的提交，评审看这之后的改动）、`hadImplementation`（上一次是否已写过代码）。第一次运行和 `--restart` 为 null |

## 迁移

只增加可选字段（缺少时按默认值处理，旧版本引擎读到也不出错）时不提升版本，以便回滚到旧版本后仍能继续已有的流水线；在上表中注明"可选"和起始版本即可。

引擎（`engine/src/state.ts`）中 `STATE_VERSION` 是当前版本，`STATE_MIGRATIONS[n]` 把第 n 版升级到第 n+1 版。增加必需字段或改变已有字段的含义时：

1. `STATE_VERSION` 加 1。
2. 在 `STATE_MIGRATIONS` 中加一个从旧版本到新版本的函数，为旧文件补上默认值。
3. 在 `engine/test/state.test.ts` 中加一条迁移测试，更新本文件。
