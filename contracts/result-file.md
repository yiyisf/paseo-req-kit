# 步骤结果文件

每个步骤结束时写一个 JSON 对象到 `.pipeline/results/<步骤键>.json`（路径在提示词的 `<pipeline-context>` 中给出）。引擎只根据它决定下一步，不读 agent 的回复文字。缺失或格式不对时，引擎会在同一个会话里提醒补写，最多 `resultFollowUps` 次（默认 2），仍不对则判定该步骤失败。

| 步骤 ID | 字段 |
| --- | --- |
| `design` | `has_runnable_service`: boolean。可选（1.8 起）：`slices`: 字符串数组（实施计划的切片，按实现顺序；两片以上时按片逐个实现）；`files`: 字符串数组（预计改动的文件和目录，目录以 `/` 结尾，可用 `*`，用于范围检查）；缺陷类型的 `reproduced`: boolean，为 `false` 时 `questions`: 非空字符串数组（需要需求方补充的信息） |
| `design_review` | `verdict`: `approved` \| `changes_required` \| `blocked`；为 `blocked` 时 `questions`: 非空字符串数组 |
| `design_revise` | `status`: `done` \| `partial`。可选（1.8 起）：`slices`、`files`，修订改变了切片或文件清单时写完整的新列表 |
| `implement`、`review_fix`、`defect_fix` | `status`: `done` \| `partial`。按切片实现时，每片的键为 `implement-s<序号>` |
| `code_review` | `verdict`: `pass` \| `changes_required` |
| `service_start` | `started`: boolean |
| `verify` | `result`: `pass` \| `defects_found` \| `blocked` |
| `reverify` | `result`: `pass` \| `defects_remaining` |
| `report` | `outcome`: `completed` \| `completed_with_issues` \| `not_completed`；`summary`: string |
| `panel_review`（评审小组成员，键为 `<评审步骤>-r<轮次>-p<序号>`） | `status`: `done` \| `partial`；意见写在 `<功能目录>/review-panel/<键>.md` |

字段定义以 `engine/src/steps.ts` 为准；改动时同步更新各步骤提示词末尾的"结果文件"一节。
