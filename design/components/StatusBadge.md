# StatusBadge

状态徽章：颜色 + 图标 + 中文词，三者缺一不可。

| 状态 | 类 | 图标 | 词 |
|---|---|---|---|
| 进行中 | `rk-badge--running` | 旋转圆 | 实现中 / 验证中 / 正在运行 |
| 已完成、通过 | `rk-badge--success` | `CircleCheck` | 已完成 / 已验证 / 已修复 / 已合并 |
| 没通过 | `rk-badge--failed` | `CircleX` | 没通过 / 失败 |
| 警告、待验收 | `rk-badge--warning` | `TriangleAlert` | 重要 / 待验收 / 超时 |
| 等你处理 | `rk-badge--needs` | `CircleDot` | 请你表态 / 等你确认 |
| AI 结论 | `rk-badge--ai` | `Sparkles` | 可以合并 / AI 已验证 |
| 没验证、对齐中 | `rk-badge--muted` | `CircleDashed` | 没验证 / 对齐中 / 建议 |

- 词写这个状态对人意味着什么，不写内部代码（不写 `waiting_for_business`）。
