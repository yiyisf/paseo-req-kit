# 0014 外部通知只留接口，不内置任何 IM

- 状态：已采纳

## 背景

需求方往往不一直盯着 Paseo 对话，"需要你决定""开发中断""已完成"这几个时刻希望在企业内部 IM 中收到。各企业的 IM 不同，鉴权和接口多是内部的，req-kit 无法也不应该内置。

## 决定

- 引擎在 milestone、blocked、permission、failed、completed 五个时刻，除发回发起的对话外，调用配置中 `notifiers` 列出的本机模块，事件格式见 [contracts/notifier-event.md](../../contracts/notifier-event.md)（`schema: 1`）。
- 模块由使用方实现（从 `notifiers/im-template.mjs` 复制），req-kit 不为它安装依赖。
- `notifiers` 只能写在本机或团队配置中，项目配置中的会被忽略：项目仓库里的内容不应决定在本机执行哪段代码、往哪里发消息。
- 通知失败或超过 15 秒只记日志，不影响流水线。
- `req notify-test` 发示例事件，接入时不需要真的运行流水线。

## 影响

接入 IM 只需写一个函数。事件格式成为对外约定，同一 `schema` 内只增加字段。
