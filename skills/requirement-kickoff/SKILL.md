---
name: requirement-kickoff
description: 旧入口，已改名为 /req。用户输入 /requirement-kickoff 时使用：提示改用 /req，并按 /req 继续处理。
metadata:
  opencode/slash: "true"
---

# 旧入口：/requirement-kickoff

用户的话：$ARGUMENTS

这个入口已经改名为 `/req`（req-kit {{REQ_KIT_VERSION}}），功能相同，并且新增了小改动、查看进度、暂停和继续等场景。

1. 先用一句话告诉用户：以后请输入 `/req`（Pi 中为 `/skill:req`），这次照常处理。
2. 然后读取 `{{REQ_KIT_ROOT}}/skills/req/SKILL.md`，把用户的话当作 `/req` 的输入，按它的说明继续。

这个过渡入口会在 req-kit 2.0 中移除。
