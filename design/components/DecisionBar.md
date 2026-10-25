# DecisionBar

决定栏：审查类网页底部固定的一条，是每页唯一放主按钮的地方。

- `surface-1` + 上描边 + `shadow-float`；内容最宽 1200px。
- 左：进度摘要（`title-sm` 一行 + `caption` 一行，说明提交后会发生什么）；中：评审人、审核人等少量输入；右：次要动作 + 主按钮。
- 640px 以下输入框两两一行、按钮占满一行；正文底部留出决定栏的高度。
- 底部加 `env(safe-area-inset-bottom)`。
