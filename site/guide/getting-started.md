# 快速开始

从环境安装到跑通你的第一个需求，大约只需 15 分钟。
安装只需在**运行 Paseo daemon 的那台机器**上执行一次即可，后续所有同事和工作区均可直接受益。

---

## 第一步：一键环境安装

选择与你操作系统匹配的安装命令：

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

### 安装脚本全自动执行事项：
1. **基础依赖环境核验**：自动检测 Node.js 22+、npm 和 git 运行环境；
2. **下载与布局**：自动安装 `paseo-req-kit` 全局或隔离运行时（当 npm 全局目录不可写时自动安装至 `~/.req-kit/npm`，免除 sudo 权限困扰）；
3. **Paseo 运行时就绪**：若未安装 Paseo，自动安装相匹配的 `@getpaseo/cli`，开启自带 Web 界面并启动 daemon（浏览器打开 `http://localhost:6767/` 即可直接使用）；若已有 Paseo，则核对版本并启用 Web 界面；
4. **注册 Skill 指令**：执行 `req setup`，把版本部署至 `~/tools/req-kit/versions/<版本>`，为系统中的 Claude Code、Codex 等自动挂载 `/req`、`/req-setup`、`/req-doctor` 等 Skill；
5. **模型角色向导**：触发交互式向导 `req configure`，分别为 **实现者 (Builder)** 和 **评审者 (Reviewer)** 选择对应的 Agent 模型；
6. **Paseo 专属插件提示**：询问是否安装 req-kit Paseo 插件，安装后可在 Paseo 原生 UI 中直观查看需求总览、进度、文档以及直接确认方案。

再次运行同一条命令即可平滑升级。常用选项：

::: tip 离线或特定版本安装
如需体验包含最新特性的测试版本或指定安装，只需追加参数：
```sh
curl -fsSL https://paseo-req-kit.vercel.app/install.sh | sh -s -- --beta             # 安装最新 beta 版
curl -fsSL https://paseo-req-kit.vercel.app/install.sh | sh -s -- --version 1.8.0    # 安装指定版本
curl -fsSL https://paseo-req-kit.vercel.app/install.sh | sh -s -- --skip-paseo       # 不检查、不安装 Paseo
```
内网或离线安装详情，请查看 [安装与升级指南](./install)。
:::

---

## 第二步：运行环境体检

安装完成后，在终端运行体检命令：

```sh
req doctor
```

体检工具将快速校验：安装路径完整性、模型免确认交互模式、Paseo daemon 通信状态以及模型额度。如果检查结果均为 `✓`（或仅包含温和的 `⚠` 警告），说明环境已准备就绪。

::: details Windows PowerShell 执行策略提示
若在 PowerShell 中被脚本策略拦截，请改用 `req.cmd doctor`，或在标准 CMD 控制台窗口中执行。
:::

---

## 第三步：项目接入（每个项目仅需执行一次）

在 Paseo 中打开你想要接入的本地项目主目录（推荐在 `main` 主分支），开启新会话并输入：

```text
/req-setup
```

Agent 会自动分析项目结构，实际运行依赖安装、构建测试及常驻服务启动命令，并在测试通过后自动生成以下规范配置文件：

| 生成配置文件 | 核心作用与价值 |
| :--- | :--- |
| `.requirement-pipeline/project-notes.md` | 固化项目工程约定：包管理工具、受保护目录、Commit 格式 |
| `.requirement-pipeline/verify.md` | 沉淀跑通的真实指令：依赖安装、测试运行、服务启停脚本 |
| `paseo.json` | 配合 Paseo 实现新工作区环境全自动初始化及端口隔离托管 |

---

## 第四步：发起你的第一个真实需求

在项目的 Paseo 对话中，输入 `/req` 配合一句话简要需求：

```text
/req 登录页增加短信验证码登录
```

接下来感受顺畅的自动化开发交付之旅：

1. **结构化访谈**：AI 复述其理解，一次只抛出一个澄清问题并给出专业推荐项；
2. **独立模型审阅**：标准档将调动第二个独立模型审阅生成的 `spec.md`，把潜藏漏洞逐一提示给你；
3. **确认开工**：核对验收标准后确认，可选择立即执行或预约时间（如 `--verify-at 22:00`）；
4. **后台流水线**：所有子任务作为子 Agent 挂载在主对话下，方案、代码、评审透明可见；
5. **从严验收结单**：完成后自动汇报包含完整执行证据的验收报告，你只需说一句“我要验收”，AI 将带你逐条把关交付！

::: tip 首次体验小建议
初次上手建议挑选一个轻量改动（例如修改一段展示文案或添加简单表单校验），走快速档，只需十几分钟即可完整领略多 Agent 流水线交付的魅力。
:::

---

## 接下来，继续深入探索：

- 📖 **[使用者指南](./user)**：学习日常对话技巧、状态查询与终验指南；
- ⚙️ **[工作原理](./how-it-works)**：深入了解 9 个步骤机制与规范产物结构；
- 🎛️ **[项目定制与运行规则](./project)**：掌握评审小组、分阶段提测与企业 IM 机器人配置。
