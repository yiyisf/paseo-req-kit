# 配置项

配置分三层，后者覆盖前者：

1. **本机配置** `~/.req-kit/config.json`（`REQ_KIT_HOME` 可以改变目录）——`req configure` 生成；
2. **团队配置**：本机配置的 `teamConfig` 指向的文件，适合放进团队共用的仓库；
3. **项目配置**：仓库根目录的 `.requirement-pipeline.json`，只写和本机不同的部分。

`daemonUrl`、`daemonPasswordEnv`、`teamConfig` 只能写在本机配置中；`notifiers` 不能写在项目配置中（会运行代码）。写错时，流水线启动前会说明哪一项、为什么。完整的示例见仓库的 [config.example.json](https://github.com/yiyisf/paseo-req-kit/blob/main/config.example.json)。

## agent

```json
{
  "agents": {
    "builder": { "paseoProfile": "实现" },
    "reviewer": { "provider": "codex/<模型 ID>", "modeId": "full-access" }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `paseoProfile` | Paseo 中 agent profile 的名称；写在它旁边的字段优先 |
| `provider` | `provider/model`，例如 `claude/claude-sonnet-5`、`pi/anthropic/claude-sonnet-5` |
| `modeId` | 必须是不会停下来请求批准的模式：Claude Code `bypassPermissions`、Codex `full-access`、OpenCode `build`（加 `featureValues: { "auto_accept": true }`）、Pi 不写 |
| `thinkingOptionId`、`featureValues`、`options` | 原样传给 provider |

## 流程

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `defaultProfile` | `standard` | 需求说明没写档位时用的档位 |
| `profiles.<档位>.rounds` | 快速 1/1/1，标准 2/3/3 | 方案审核、代码评审、缺陷修复的最多轮数 |
| `profiles.<档位>.serviceStart` | 快速 false，标准 true | 是否做服务启动验证 |
| `phases` | 连续 | 执行方式和测试阶段的选项，见 [分阶段执行与提测](/guide/phases) |
| `specReview` | `standard` | 确认前独立审阅需求说明：`standard`（标准档）、`always`、`off` |
| `designProposals` | 关闭 | `{"enabled": true}`：方案设计前由几个 agent 并行各提一份方案 |
| `reviewPanel` | 关闭 | 评审小组：首轮方案审核和代码评审由多位成员并行评审，再由 reviewer 核实汇总 |
| `stepTimeoutMinutes.<步骤>` | 20–240 分钟 | 每个步骤的总时限 |
| `resultFollowUps` | 2 | 结果文件缺失或不合格时提醒补写的次数 |
| `retry` | 2 次，等 60/300 秒 | 临时错误（限流、网络）后自动重做这一步 |

## Paseo 能力

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `attachToOriginChat` | `true` | 步骤 agent 作为子 agent 挂在发起的对话下 |
| `archiveStepAgents` | `false` | 步骤完成后归档它的 agent |
| `paseoServices` | `auto` | 用 `paseo.json` 中的服务（由 Paseo 启动、分配端口）；`off` 由步骤 agent 自己启动 |
| `serviceReadySeconds` | 120 | 等待服务就绪的时间 |
| `browserVerify` | `auto` | 有 Paseo 浏览器工具时，验证步骤在浏览器中实际操作 |
| `quotaWarnPercent` | 85 | 开始时额度用到这个比例以上就提醒；0 关闭 |

## 通知与调度

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `notifyMilestones` | `true` | 关键节点（方案确定、开始验证、修复缺陷）在对话里说一句 |
| `notifiers` | `[]` | 外部通知模块（企业 IM 等），见 [外部通知事件](/reference/contracts/notifier-event) |
| `waitingReminderHours` | 24 | 等待需求方回答、或研发完成待测试超过这么久，提醒一次；0 关闭 |
| `autoResumeMinutes` / `autoResumeMax` | 30 / 2 | 临时错误中断后自动继续的等待时间和次数；0 关闭 |
| `watchdogMinutes` | 0 | 运行期间定时检查，进程意外退出时自动继续；0 关闭 |
| `maxConcurrentPipelines` | 0 | 本机同时运行的流水线上限，满了排队；0 不限 |
| `queuePollSeconds` | 60 | 排队时检查空位的间隔 |

## 本机与团队

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `daemonUrl` | `ws://127.0.0.1:6767/ws` | Paseo daemon 地址 |
| `daemonPasswordEnv` | `PASEO_DAEMON_PASSWORD` | 存放 daemon 密码的环境变量名 |
| `teamConfig` | `null` | 团队配置文件的路径 |
| `requiredVersion` | `null` | 团队或项目期望的 req-kit 版本范围，例如 `">=1.7.0 <2"`；只提醒不阻止 |
| `waitChunkSeconds`、`permissionPollSeconds` | 600、30 | 等待步骤 agent 的分段长度、检查权限批准的间隔 |
