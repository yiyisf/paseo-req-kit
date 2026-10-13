# 0017 用好 Paseo 自身的能力：profile、工作区脚本、用量和时间线

- 状态：已采纳

## 背景

1.3 及以前，req-kit 只用到 Paseo 的"创建 agent 并挂在对话下"和"等待结束"。Paseo 0.11 已经提供了 agent profile（带使用说明的启动配置）、`paseo.json`（worktree 准备脚本和受监管的服务，每个工作区独立端口）、provider 用量、agent 时间线等能力。req-kit 自己再实现一遍既重复，又和使用者在 Paseo 界面里看到的不一致。

## 决定

- **agent 配置可以引用 Paseo profile**（`paseoProfile`），在每次运行开始时从 daemon 读取并解析；找不到时拒绝启动并列出现有的 profile。
- **服务交给 Paseo**：对话所在工作区的 `paseo.json` 定义了服务时，流水线在需要服务的步骤前通过 Paseo 重启它们，结束后停止；步骤 agent 只拿到地址和状态。`paseoServices: "off"` 或没有发起对话时，仍由步骤 agent 自己启动。
- **用量和时间线只用于提示**：额度紧张时提醒一次，不阻止运行；查看进度时附上 agent 最近的活动，读不到就省略。
- 工作区脚本在 `@getpaseo/client` 0.11 的公开 API 中还没有，暂时通过它导出的 `internal/daemon-client` 调用，并且每一处都在不可用时退回原来的做法。req-kit 已经把 Paseo 版本限定在 0.11.x（`reqKit.paseo`），升级 Paseo 支持范围时必须复查这一处。

## 影响

使用者在 Paseo 里改 profile、写 `paseo.json` 就能影响流水线，不必再改 req-kit 的配置。依赖了一个内部接口，升级 Paseo 时有额外的检查项（维护者指南的发布流程中已列出）。
