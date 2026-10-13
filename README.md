# Paseo 需求开发工作流 · 使用说明

帮助不写代码的业务同事，用业务语言把需求谈清楚，再由一组 AI agent 按标准步骤完成设计、实现、评审、验证，最后给出一份白话报告。

## 1. 工作流的 11 个步骤

| 步骤 | 内容 | 谁来做 | 产物（都在功能目录下） |
| --- | --- | --- | --- |
| 1 | 用业务语言对齐需求（基于 grill-with-docs） | 聊天 agent 与用户对话 | `alignment.md`、`CONTEXT.md`、`docs/adr/` |
| 2 | 生成标准需求说明，用户确认 | 聊天 agent | `spec.md` |
| 3 | 方案设计 | 实现 agent | `design.md` |
| 4 | 方案审核（需要时修订，可多轮） | 审核 agent / 实现 agent | `design-review.md` |
| 5 | 代码实现（适合时采用 TDD） | 实现 agent | 代码、`implementation.md` |
| 6 | 代码评审 | 审核 agent | `code-review.md` |
| 7 | 评审问题修复（与第 6 步可多轮） | 实现 agent | 代码、处理记录 |
| 8 | 服务启动验证（项目有常驻服务时） | 实现 agent | `service-start.md` |
| 9 | 功能验证：基础测试 + 端到端 | 审核 agent | `verification.md` |
| 10 | 缺陷修复与复验（可多轮） | 实现 agent / 审核 agent | 代码、`verification.md` |
| 11 | 完成报告与总结 | 实现 agent | `report.md` |

功能目录形如 `docs/features/20261012-sms-login/`，代码改动在分支 `feature/20261012-sms-login` 上，只做本地提交，合并上线由人决定。

## 2. 包里有什么

```text
paseo-requirement-workflow/
├── README.md              本文件（使用说明）
├── script-pipeline/       推荐：脚本版（第 1–2 步在聊天中，第 3–11 步由脚本驱动）
│   ├── README.md          安装、配置、冒烟测试、日常使用、运行规则
│   ├── skill/             第 1–2 步的 skill（requirement-kickoff），含启动流水线和处理通知
│   ├── prompts/           第 3–11 步的提示词
│   ├── src/  bin/         流水线程序与启动命令
│   ├── test/              模拟环境下的场景测试
│   └── pipeline.config.example.json
└── hub-workflow/          备选：Paseo Hub 工作流版（第 3–11 步由 Hub 执行）
    ├── README.md
    ├── skills/            第 1–2 步的 skill（结尾只给出功能目录，不自动启动）
    └── .paseo/            hub.yml 与工作流定义、提示词
```

两个版本的提示词内容基本相同，区别在于由谁来驱动第 3–11 步：

| | 脚本版（推荐） | Hub 版 |
| --- | --- | --- |
| 与第 1–2 步的衔接 | 用户确认 spec 后，在同一个聊天里自动启动 | 需要另行启动 Hub 工作流 |
| 进展和结果 | 发回同一个聊天；步骤以子 agent 的形式显示在聊天下面 | 在 Hub 控制台和功能目录中查看 |
| 需要业务决定时 | 暂停，把问题发回聊天，用户回答后继续 | 直接生成"未完成"报告 |
| 审核、修复轮数 | 可多轮，可配置 | 各一轮（Hub 没有循环） |
| 断点续跑 | 支持 | 不支持 |
| 运行条件 | 运行 Paseo daemon 的机器上有 Node.js 22+ | Paseo Hub，且多步骤格式在文档中属于旧格式；手动启动方式文档未写明 |

## 3. 快速开始（脚本版）：在所有 Paseo 对话中启用

在运行 Paseo daemon 的机器上做一次即可，之后任何项目的新对话里都能用 `/requirement-kickoff`。详细说明见 `script-pipeline/README.md`。

```bash
mkdir -p ~/tools && cp -r script-pipeline ~/tools/requirement-pipeline
cd ~/tools/requirement-pipeline && npm install
npx skills add mattpocock/skills -g --copy     # 依赖的 grilling、domain-modeling
node install.mjs                               # 安装 skill 到各 agent 的全局目录并检查环境
```

第一次运行 `install.mjs` 会提示在 `pipeline.config.json` 中为两个角色选择 agent，填好后再运行一次，全部 ✓ 即完成。常用写法（完整说明见 `script-pipeline/README.md` 的"不同 agent 的配置"一节）：

| agent | 配置 |
| --- | --- |
| Claude Code | `{ "provider": "claude/<模型 ID>", "modeId": "bypassPermissions" }` |
| OpenCode | `{ "provider": "opencode/<上游>/<模型 ID>", "modeId": "build", "featureValues": { "auto_accept": true } }` |
| Pi | `{ "provider": "pi/<上游>/<模型 ID>" }`（不写 `modeId`） |
| Codex | `{ "provider": "codex/<模型 ID>", "modeId": "full-access" }` |

模型 ID 等可用值用 `npm run smoke -- check` 查看。然后按 `script-pipeline/README.md` 的"冒烟测试"一节确认真实环境可用。

使用：业务同事在需求所在项目中新开 Paseo 对话，输入 `/requirement-kickoff 我想……`（聊天 agent 是 Pi 时输入 `/skill:requirement-kickoff 我想……`；各 agent 的触发方式见 README），回答提问、确认 spec、同意开始开发，然后等对话里的通知。

## 4. 业务同事会经历什么

1. 在 Paseo 中为这个需求新建一个工作区（New workspace → Isolation 选 New worktree），在里面开对话。在项目主目录里开也可以，AI 会先建议改用独立工作区。
2. 和 AI 聊需求。AI 先判断是小改动还是常规需求，推荐"快速"或"标准"档；小改动只问几个关键问题。全程一次问一个问题，给出选项和推荐，不用技术词汇。
3. 读一份 10 行以内的需求摘要，确认。
4. 回答"现在开始开发吗"。
5. 等待。期间会收到几句进展（方案定了、开始验证等）；可能收到需要你做的业务决定，或者某一步在等待批准（需要请技术同事处理）。随时可以问"做到哪了"，也可以说"先停一下""继续开发"。
6. 收到结论和摘要，按报告中"需要你做的事"去试用和验收，再请技术同事合并上线。

## 5. 需要技术同事负责的事

- 安装、配置和冒烟测试（第 3 节）。
- 按项目定制（可选）：在仓库里放 `.requirement-pipeline.json`（本项目用的 agent、默认档位、轮数等）和 `.requirement-pipeline/project-notes.md`（本项目的约定，如包管理工具、不能改的目录、测试命令），随代码提交即对团队生效。见 `script-pipeline/README.md` 的"按项目定制"。
- 流水线中断时查看原因：功能目录下的 `.pipeline/pipeline.log` 和 `.pipeline/state.json`。修好后用通知里给出的继续命令续跑。
- 审阅功能分支上的代码和 `report.md`，决定是否合并。
- 提醒业务同事：在需求所在项目的 Paseo 对话中发起（最好是为这个需求新建的 worktree 工作区），对话过程中不要切换工作目录。流水线的每个步骤都挂在这个对话下、在对话的工作目录和当前分支上进行；目录不一致或当前在默认分支上时会拒绝启动。
- 安全：步骤 agent 以免确认模式运行，在本机可以执行命令。仓库目录中不要放生产环境凭据。

## 6. 验证情况

- 脚本版的编排逻辑：用模拟的 Paseo 运行真实代码，36 个场景测试全部通过；对 Paseo 0.11.2 的 SDK 源码做了类型检查，没有错误。
- 尚未在真实环境中验证：真实 daemon 与 agent 的行为、通知效果、后台进程在聊天回合结束后能否继续运行、提示词的实际产出质量。冒烟测试和一次小需求试跑就是用来确认这些的。
- Hub 版：按 Paseo 官方文档核对了字段和步骤引用，未部署运行过。
