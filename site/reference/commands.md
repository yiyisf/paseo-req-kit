# 命令

req-kit 有三类入口：在 Paseo 对话中使用的 **skill**，终端中的 **`req` 命令**，以及 skill 在背后调用的**流水线启动器**。日常使用只需要第一类。

## 对话中的 skill

| 输入 | 作用 | 通常谁用 |
| --- | --- | --- |
| `/req <一句话>` | 需求开发入口：新需求、小改动、查看进度、暂停或继续、修改需求、开始测试验证、验收、上线后问题、接手。由它判断走哪本手册 | 使用者 |
| `/req-setup` | 项目接入：生成项目说明、验证方法、`paseo.json`，确认后提交 | 开发或熟悉项目的测试同事 |
| `/req-doctor` | 体检：安装、配置、daemon、当前项目 | 任何人 |
| `/req-retro` | 复盘：需求做完后回顾返工、中断和变更，把改进落到 CI、配置、项目说明或提示词 | 开发同事 |

Pi 中写作 `/skill:req`。同一个对话里，之后的"做到哪了""先停一下""继续开发""开始测试验证""我要验收"不需要再带 `/req`。

## req 命令

安装后提供 `req`（同名命令 `req-kit`，避免和其他工具冲突）。Windows PowerShell 受执行策略限制时用 `req.cmd`。

### 在项目目录中

| 命令 | 作用 |
| --- | --- |
| `req list` | 列出这个项目所有工作区中的需求和阶段 |
| `req status [需求]` | 查看进度；只有一个需求运行过时可以不写 |
| `req stop <需求>` | 停止流水线（之后可以继续）；同时取消预约的开始、提醒、自动继续 |
| `req resume <需求>` | 从上次中断处继续；需求改过时只处理变化的部分 |
| `req approve <需求>` | 需求方看过 `preview.md` 并确认后，从方案确认点继续开发 |
| `req verify <需求> [--verify-env local\|deployed] [--defects fix\|handback\|report]` | 研发完成后开始测试验证（分阶段执行时） |
| `req start <需求> [--profile quick\|standard] [--phases gated] [--at 22:00]` | 启动流水线（通常由 `/req` 在对话中启动） |
| `req digest [--notify]` | 项目的需求总览；`--notify` 同时发到外部通知 |
| `req digest --schedule "0 9 * * 1"` | 让 Paseo 按时间表发送需求总览；取消：`req digest --cancel <ID>` |
| `req sync <需求>` | 把需求同步到对接的外部系统：补发没有成功的调用、补建卡片、更新状态 |
| `req integration test [需求]` | 显示对接外部系统时每个事件会执行的命令，不真正调用 |
| `req index --rebuild [目录…]` | 把这些仓库中运行过的需求登记进本机的需求索引（1.9 之前运行过的需求用） |

### 使用统计（任何目录）

| 命令 | 作用 |
| --- | --- |
| `req stats [--since 30d] [--month 2026-10]` | 本机的使用统计：需求数、交付周期、返工、等待、各步骤用时、用量；`--json`、`--csv` |
| `req stats --report [--out 目录]` | 生成汇报用的 `.md` 汇总和 `.csv` 明细 |
| `req stats --export [文件]` | 导出本机的运行记录 |
| `req stats --merge <文件…> --report` | 汇总几台机器的导出 |
| `req index [--prune]` | 本机记录的需求；`--prune` 移除目录已不在的 |
| `req api <命令> …` | 给程序用的 JSON 输出，见 [req api](./contracts/cli-json) |

### Paseo 插件

| 命令 | 作用 |
| --- | --- |
| `req plugin install [--yes]` | 安装或更新 req-kit 的 Paseo 插件；需要时询问是否打开 Paseo 的插件总开关 |
| `req plugin status` | 插件是否在运行 |
| `req plugin remove` | 从 Paseo 移除插件 |

`<需求>` 可以写功能目录（`docs/features/20261012-sms-login`）、目录名，或名称中能唯一确定的一部分（`sms-login`）。

### 本机维护

| 命令 | 作用 |
| --- | --- |
| `req doctor [--no-project]` | 体检：安装、配置、daemon、当前项目 |
| `req configure` | 配置向导：为 builder 和 reviewer 选择 agent |
| `req setup` | 启用 npm 安装的这个版本、安装 skill（安装脚本会自动运行） |
| `req upgrade [版本] [--beta]` | 升级到最新版本（或指定版本），自动选能支持本机 Paseo 的版本；`--check` 只看有没有新版本 |
| `req versions` | 已安装的版本和可用的版本 |
| `req use <版本>` | 切换到已安装的另一个版本（回滚） |
| `req check` | 检查安装状态 |
| `req notify-test [--type …]` | 给配置的外部通知（如企业 IM）发一条测试消息 |
| `req version` | 显示版本和安装位置 |

## 流水线启动器

`/req` 在对话中执行的是 `node <安装目录>/bin/start-pipeline.mjs`，在 bash、PowerShell、cmd 中写法相同。在 Paseo 对话中运行时，它自动识别当前对话（`PASEO_AGENT_ID`）和工作目录（`PASEO_AGENT_CWD`）。

| 选项 | 作用 |
| --- | --- |
| `--feature <功能目录>` | 要操作的需求；可以只写名称的一部分 |
| `--status` / `--stop` / `--list` | 查看进度 / 停止 / 列出需求 |
| `--resume` / `--restart` | 从中断处继续 / 丢弃结果从零开始 |
| `--profile quick\|standard` | 档位；不传时读需求说明中的"档位"，再用配置的 `defaultProfile` |
| `--phases continuous\|gated\|develop-only` | 执行方式；不传时读需求说明中的"执行方式"，再用配置的 `phases.mode` |
| `--approve` | 方案确认点：需求方确认了方案，继续开发（等待确认时单独的 `--resume` 会被拒绝；要修改就先更新需求说明再 `--resume`） |
| `--phase verify` | 开始（或继续）测试验证阶段；研发完成、待测试时单独的 `--resume` 效果相同 |
| `--verify-env local\|deployed`、`--defects fix\|handback\|report` | 开始测试验证时临时指定环境和缺陷处理方式 |
| `--verify-at <时间>` | 分阶段时，研发完成后在这个时间自动开始测试验证 |
| `--at <时间>` | 预约开始：`22:00`、`明天 8:30`、`2026-10-14 08:30`、`+2h` |
| `--worktree` | 为这个需求新建 Paseo worktree 工作区并在那里开发（对话目录不变） |
| `--spec-review` | 确认前请另一个模型独立审阅需求说明草稿 |
| `--repo`、`--origin-agent`、`--config` | 仓库目录、发起对话、配置文件（通常不需要写） |

## 安装脚本

| 系统 | 命令 |
| --- | --- |
| macOS、Linux、Git Bash、WSL | `curl -fsSL https://paseo-req-kit.vercel.app/install.sh \| sh` |
| Windows PowerShell | `irm https://paseo-req-kit.vercel.app/install.ps1 \| iex` |

`install.sh` 的选项写在 `sh -s --` 之后：`--beta`、`--version <版本>`、`--from npm|release`、`--no-configure`、`--skip-paseo`（不检查、不安装 Paseo）、`--with-plugin`（直接安装 Paseo 插件）、`--no-plugin`。`install.ps1` 的选项用变量：`$ReqKitBeta = $true`、`$ReqKitVersion = "1.8.0"`、`$ReqKitFrom = "release"`、`$ReqKitNoConfigure = $true`、`$ReqKitSkipPaseo = $true`、`$ReqKitPlugin = "yes"`（或 `"no"`）。没有 Paseo 时脚本会安装 Paseo 命令行、开启它的网页界面并启动 daemon。
