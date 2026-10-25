# DiffBlock

差异块：一个文件的改动。

- 头部 `surface-3`：折叠箭头、文件路径（等宽）、`+12 −3`（`diff-added` / `diff-removed`）、右侧审核人。
- 行：两列行号（`text-muted`、`tabular-nums`）+ 代码；新增行 `success-tint`，删除行 `failed-tint`，前面用 `+` / `−` 符号，不只靠颜色。
- 意见插在对应行下面（`tr.note`），左边缩进到代码列。
- 在自己的容器里横向滚动；需求文档类文件排在最后、默认折叠；超大文件只显示前 3000 行并说明。
