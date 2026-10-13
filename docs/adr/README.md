# 设计决定（ADR）

req-kit 自身的设计决定。修改其中任何一条，请新增一条 ADR 说明理由，并在旧的一条中注明被哪条取代。

- [0001 步骤 agent 挂在发起的对话下](0001-step-agents-under-origin-chat.md)
- [0002 对话过程中不切换工作目录](0002-no-directory-switch-in-chat.md)
- [0003 第 3–11 步由脚本引擎驱动，不用 Hub 多步骤工作流](0003-script-engine-not-hub.md)
- [0004 步骤结论只看结果文件](0004-result-files.md)
- [0005 不在默认分支上运行，只做本地提交](0005-no-default-branch-local-commits-only.md)
- [0006 只安装到 ~/.agents/skills 和 ~/.claude/skills](0006-skill-install-targets.md)
- [0007 自带需求访谈 skill，不依赖外部 skill 包](0007-own-interview-skill.md)
- [0008 入口 skill 之间不互相调用](0008-entries-do-not-call-entries.md)
- [0009 程序与本机配置分开存放，按版本目录并存](0009-versioned-install-layout.md)
- [0010 需求总览现场生成，不维护 INDEX.md](0010-generated-feature-overview.md)
- [0011 完成后修改 spec 可以继续开发](0011-resume-after-completion.md)
- [0012 评审小组：首轮并行评审，评审者核实汇总](0012-review-panel.md)
- [0013 发布不使用 changesets 等工具](0013-no-release-tooling.md)
- [0014 外部通知只留接口，不内置任何 IM](0014-notifier-slot.md)
- [0015 需求变更后增量继续，而不是从零重做](0015-incremental-continue.md)
- [0016 一键升级：从 git 标签下载到 versions/ 再切换](0016-upgrade-from-tags.md)
