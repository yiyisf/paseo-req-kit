# 0027 Paseo 插件：随 req-kit 一起发布，只通过 req api 工作

- 状态：已采纳（建立在 [0026](0026-machine-records-and-api.md) 的需求索引和 `req api` 之上；不改变 [0003](0003-script-engine-not-hub.md)：流程仍由脚本引擎驱动）

## 背景

需求方和项目经理想在 Paseo 的网页端或手机上看到所有需求在哪一步、卡在哪里，并做确认方案、停止、继续这类操作，而不是在对话里问或在终端敲 `req`。Paseo 0.11 有完整的插件机制：界面（侧边栏、页面、工作区面板、按钮、命令中心）、daemon 侧的 RPC 和生命周期事件，同一份界面代码在桌面版、网页端和手机上运行。

## 决定

- **插件只做展示和管理，不参与流程**：每个读取是一次 `req api`，每个管理操作是 `req api run <approve|stop|resume|verify>`，与在终端执行 `req <命令>` 完全相同。插件不读写状态文件，引擎仍是唯一修改需求状态的一方。不提供发起需求（需要在对话中对齐）、编辑需求说明或方案、修改配置、删除。
- **随 req-kit 一起发布，从固定目录安装**：插件源码在仓库的 `paseo-plugin/`，打进 `paseo-req-kit` 包。`req plugin install` 把当前版本的插件复制到 `~/.req-kit/paseo-plugin`，用 `paseo plugin install <目录>` 安装；之后每次启用版本（setup、upgrade、use）都刷新这个目录并 `paseo plugin reload`。这样插件版本总是和启用的 req-kit 一致，也不需要单独的 npm 包、网络或第二套发布配置。设计时曾考虑第二个 npm 包，Paseo 的目录安装让它变得不必要。
- **插件总开关要人同意**：Paseo 的 `pluginsEnabled` 默认关闭，插件是不受沙箱限制的代码。`req plugin install` 和安装脚本都先说明再询问，`--yes` / `--with-plugin` 表示同意；移除插件不改动总开关。
- **只读模式**：Paseo 的插件没有按用户区分的权限，能连上 daemon 的人都能操作。插件设置中的"只读"隐藏管理操作，daemon 侧也拒绝它们。
- **只依赖 `req api` 的格式**：插件通过本机配置目录的 `active.json` 找到启用的版本并运行它的 `req api`，不引用 req-kit 的内部代码；req-kit 太旧时插件给出升级提示。
- **界面按 Paseo 的跨平台规则写**：只用 React Native 组件和主题颜色，不用 DOM。插件的界面部分由 CI 用 Paseo 的 SDK 做类型检查（`paseo-plugin/` 的开发依赖），daemon 侧和 `req plugin` 有单元测试；界面效果需要在真实的 Paseo 中检查。

## 影响

- 新增 `req plugin install|status|remove`，安装脚本最后可选安装插件。
- 列表靠轮询刷新（默认 10 秒，可设置）；daemon 侧把短时间内的多个列表请求合并成一次 `req api list`。
- 步骤 agent 的"需求"按钮靠 req-kit 给步骤 agent 打的标签（`requirement-pipeline`）找到需求；工作区的"需求"按钮按目录匹配需求。
- `paseo-plugin/package.json` 的版本必须与 req-kit 相同（测试检查），`paseo-plugin.json` 的 Paseo 范围与 `reqKit.paseo` 相同。
