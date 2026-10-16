# 快速开始

从安装到第一个需求，大约 15 分钟。安装只需在**运行 Paseo daemon 的那台机器**上做一次。

## 1. 安装

::: code-group

```sh [macOS / Linux]
curl -fsSL https://paseo-req-kit.vercel.app/install.sh | sh
```

```powershell [Windows PowerShell]
irm https://paseo-req-kit.vercel.app/install.ps1 | iex
```

```sh [Windows Git Bash / WSL]
curl -fsSL https://paseo-req-kit.vercel.app/install.sh | sh
```

:::

安装脚本会依次：

1. 检查 Node.js 22+、npm 和 git；
2. 安装 `paseo-req-kit`（npm 上有就从 npm 安装，否则用 GitHub Release 的安装包；npm 全局目录不可写时装到 `~/.req-kit/npm`，不需要 sudo）；
3. 检查 Paseo：没有 Paseo 时安装与 req-kit 匹配的 Paseo 命令行（`@getpaseo/cli`），开启它自带的网页界面并启动 daemon；已有 Paseo 时核对版本、开启网页界面（不会自动重启正在运行的 daemon）。之后浏览器打开 `http://localhost:6767/` 就是 Paseo；
4. 运行 `req setup`：把这个版本装到 `~/tools/req-kit/versions/<版本>`，并为 Claude Code、Codex 等安装 `/req` 等 skill；
5. 运行配置向导 `req configure`，为"实现"（builder）和"评审"（reviewer）各选一个 agent——建议选两个不同的模型；
6. 最后询问是否安装 req-kit 的 Paseo 插件：在 Paseo 的界面里看需求总览、进度和文档，并确认方案、停止、继续（会先征得同意再打开 Paseo 的插件总开关）。

再次运行同一条命令即升级。常用选项：

```sh
curl -fsSL https://paseo-req-kit.vercel.app/install.sh | sh -s -- --beta             # 包括 beta 版
curl -fsSL https://paseo-req-kit.vercel.app/install.sh | sh -s -- --version 1.9.0
curl -fsSL https://paseo-req-kit.vercel.app/install.sh | sh -s -- --skip-paseo       # 不检查、不安装 Paseo
```

::: tip 不能用一键脚本时
也可以手工安装，或者在公司内网用离线安装包，见 [安装与升级](./install)。
:::

## 2. 体检

```sh
req doctor
```

它检查安装、配置、Paseo daemon、agent 的模式（必须是免确认模式）和额度。全部是 ✓ 或只有 ⚠ 即可继续；✗ 的项按提示处理。

::: details Windows 上 `req` 命令被执行策略拦住？
在 PowerShell 中改用 `req.cmd doctor`，或在 cmd 窗口中运行。
:::

## 3. 接入项目（每个项目一次）

在 Paseo 中打开项目主目录（最好在主分支上），新开对话，输入：

```text
/req-setup
```

agent 会读项目、只问读不出来的事、把安装依赖/测试/启动服务的命令实际跑一遍，然后生成并请你确认这些文件：

| 文件 | 作用 |
| --- | --- |
| `.requirement-pipeline/project-notes.md` | 项目约定：包管理工具、不能改的目录、提交格式 |
| `.requirement-pipeline/verify.md` | 验证方法：实际跑通的安装、测试、启动命令 |
| `paseo.json` | 新建工作区时自动准备环境；服务由 Paseo 托管，每个工作区独立端口 |

## 4. 提第一个需求

在项目的 Paseo 对话中输入 `/req` 和一句话：

```text
/req 登录页增加短信验证码登录
```

接下来：

1. AI 复述理解，一次问一个问题；拿不准时说"你定"。
2. 标准档会请另一个模型独立审阅需求说明，把发现的问题逐个问你。
3. 确认需求说明后，选择现在开始或预约时间（例如今晚 10 点）。
4. 开发在后台进行，每一步都出现在对话的子 agent 列表中；你会收到几句进展。
5. 完成后收到结论和报告，说"我要验收"，按验收标准逐条核对。

::: tip 从一个小需求开始
第一次建议用一个范围很小的改动（例如改一段文案），走快速档，十几分钟就能看到完整的流程。
:::

## 下一步

- [使用者指南](./user)：过程中可以说什么、会收到哪些通知、怎么验收。
- [工作原理](./how-it-works)：流水线的每一步做什么、产物在哪里。
- [项目定制与运行规则](./project)：档位、评审小组、分阶段执行、通知等配置。
