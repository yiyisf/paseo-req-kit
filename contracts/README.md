# 文件格式约定

这些文件同时被聊天中的 skill、流水线引擎和步骤 agent 读写。改动格式时，同时更新这里、相关代码和测试，并在 `CHANGELOG.md` 的"升级须知"中说明。

| 文件 | 约定 | 格式版本 |
| --- | --- | --- |
| `docs/features/<目录>/spec.md` | [spec.md](spec.md) | `req-kit/spec@1` |
| `docs/features/<目录>/.pipeline/state.json` | [state.md](state.md) | `version: 1` |
| `docs/features/<目录>/.pipeline/results/<步骤>.json` | [result-file.md](result-file.md) | 按步骤固定字段 |
| `decisions.tsv`、`changes.md`、`acceptance.md` 与需求总览 | [feature-files.md](feature-files.md) | 见各文件说明 |
| `.requirement-pipeline/verify.md` | [verify.md](verify.md) | 自由格式，建议结构见文件 |
| 外部通知（企业 IM 等）收到的事件 | [notifier-event.md](notifier-event.md) | `schema: 1` |

格式版本的规则：

- 同一主版本内只做可以自动迁移的变更。
- 引擎读到旧版本的状态文件时自动迁移，原文件保留为 `state.json.bak-v<旧版本>`。
- 读到比自己新的版本时拒绝运行，提示升级 req-kit 或恢复备份。
