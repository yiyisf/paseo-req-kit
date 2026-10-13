# 外部通知事件（notifier）

流水线除了把消息发回发起的对话，还可以在关键时刻调用本机的通知模块，例如把消息转发到企业内部 IM。req-kit 只定义调用方式和事件格式，不包含任何 IM 的实现；模板见 [notifiers/im-template.mjs](../notifiers/im-template.mjs)。

## 配置

只能写在本机配置（`~/.req-kit/config.json`）或团队配置中，项目配置中的 `notifiers` 会被忽略（项目仓库里的代码不应该决定往哪里发消息）。

```json
"notifiers": [
  {
    "module": "~/.req-kit/notifiers/im.mjs",
    "events": ["blocked", "failed", "completed"],
    "options": { "webhook": "https://im.example.internal/hook/xxx", "tokenEnv": "IM_TOKEN" }
  }
]
```

| 字段 | 说明 |
| --- | --- |
| `module` | 通知模块的路径。相对路径相对于声明它的配置文件；`~/` 表示用户目录。 |
| `events` | 要接收的事件类型，省略时接收全部（包括以后新增的类型）。 |
| `options` | 原样传给模块的第二个参数。密钥不要直接写在这里，写环境变量的名字，由模块读取。 |

## 模块

ES 模块，默认导出（或导出名为 `notify` 的）函数：

```js
export default async function notify(event, options) { /* 发送 */ }
```

- 每个事件调用一次，可以返回 Promise。超过 15 秒没有完成按失败处理。
- 抛出的错误和超时只记入流水线日志（"外部通知失败……不影响流水线"），不会让流水线停下或重试。
- 模块在一次流水线运行中只加载一次；修改模块后，对之后启动或继续的流水线生效。
- 测试：`req notify-test [--type blocked|failed|completed|milestone|permission]` 发一条带"【测试】"字样的示例事件，不需要运行流水线。

## 事件格式（schema 1）

```json
{
  "schema": 1,
  "type": "blocked",
  "at": "2026-10-13T08:30:00.000Z",
  "kitVersion": "1.3.0-beta.1",
  "feature": { "dir": "docs/features/20261012-sms-login", "name": "20261012-sms-login", "title": "短信验证码登录" },
  "repo": "D:\\work\\shop",
  "branch": "feature/20261012-sms-login",
  "profile": "standard",
  "originAgentId": "agent-id 或 null",
  "text": "方案审核发现 1 个需要需求方决定的问题，流水线已暂停，请到发起的对话中回答。",
  "details": { "questions": ["……"], "resumeCommand": "node \"…/start-pipeline.mjs\" … --resume" }
}
```

`text` 是一两句可以直接发出的话；需要自己排版时用 `details`。

| type | 什么时候 | details |
| --- | --- | --- |
| `milestone` | 方案确定、开始验证、开始修复缺陷（配置 `notifyMilestones` 为 true 时，每次尝试各一次） | `milestone`：`design-settled`、`code-reviewed`、`fixing-defects` |
| `blocked` | 方案审核发现需要需求方决定的问题，流水线已暂停 | `questions`（字符串数组）、`resumeCommand` |
| `permission` | 步骤 agent 在等待权限批准 | `stepTitle`、`agentTitle`、`requests`（字符串数组） |
| `failed` | 流水线因错误中断（已自动重试过的临时错误除外） | `stepTitle`、`reason`、`logPath`、`resumeCommand` |
| `completed` | 流水线结束，报告已生成 | `outcome`（`completed`、`completed_with_issues`、`not_completed`）、`summary`、`reportPath` |
| `digest` | `req digest --notify`（或由 `req digest --schedule` 创建的 Paseo 定时任务）发送项目的需求总览，1.6.0 起。`feature.title` 为"<项目> 需求总览"，`text` 是完整的多行总览 | `features`：每个需求的 `name`、`title`、`stage`、`branch`、`updatedAt`、`usage` |

## 兼容性

- 同一 `schema` 内只增加字段，不删除、不改含义；模块应忽略不认识的字段和事件类型。
- 不兼容的变化会提升 `schema`，并在 `CHANGELOG.md` 的"升级须知"中说明。
