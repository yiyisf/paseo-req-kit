# 0006 只安装到 ~/.agents/skills 和 ~/.claude/skills

- 状态：已采纳

## 背景

Paseo 运行各 agent 自己的命令行工具。~/.agents/skills 被 Codex、Pi、OpenCode 读取；Claude Code 读 ~/.claude/skills。同时装到更多目录会让同一个 skill 出现多份。

## 决定

默认安装到 ~/.agents/skills，以及存在时的 ~/.claude/skills；其他目录用 --target 追加并被记住。暂不安装到 ~/.codex/skills。

## 影响

覆盖四种 agent。Codex 的触发方式需要在真实环境中确认。
