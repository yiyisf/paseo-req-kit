# 0007 自带需求访谈 skill，不依赖外部 skill 包

- 状态：已采纳

## 背景

脚本版依赖 Matt Pocock 的 grilling 和 domain-modeling。后者已把术语文件从 CONTEXT.md 改为 GLOSSARY.md，说明外部依赖的文件约定会漂移。

## 决定

req-kit 自带 requirement-interview，术语写入 GLOSSARY.md，读取时兼容 CONTEXT.md。

## 影响

安装少一步，行为由 req-kit 自己掌控和评估。
