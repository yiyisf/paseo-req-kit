# 步骤结果文件

每个步骤结束时写一个 JSON 对象到 `.pipeline/results/<步骤键>.json`（路径在提示词的 `<pipeline-context>` 中给出）。引擎只根据它决定下一步，不读 agent 的回复文字。缺失或格式不对时，引擎会在同一个会话里提醒补写，最多 `resultFollowUps` 次（默认 2），仍不对则判定该步骤失败。

| 步骤 ID | 字段 |
| --- | --- |
| `design` | `has_runnable_service`: boolean |
| `design_review` | `verdict`: `approved` \| `changes_required` \| `blocked`；为 `blocked` 时 `questions`: 非空字符串数组 |
| `design_revise`、`implement`、`review_fix`、`defect_fix` | `status`: `done` \| `partial` |
| `code_review` | `verdict`: `pass` \| `changes_required` |
| `service_start` | `started`: boolean |
| `verify` | `result`: `pass` \| `defects_found` \| `blocked` |
| `reverify` | `result`: `pass` \| `defects_remaining` |
| `report` | `outcome`: `completed` \| `completed_with_issues` \| `not_completed`；`summary`: string |

字段定义以 `engine/src/steps.ts` 为准；改动时同步更新各步骤提示词末尾的"结果文件"一节。
