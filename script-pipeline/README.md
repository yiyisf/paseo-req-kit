# 需求开发流水线（脚本版）

把需求开发工作流的第 3–11 步交给一组 Paseo agent 自动执行。它由第 1–2 步（`/requirement-kickoff` 需求对齐）所在的聊天直接启动，过程中的进展和最终结果也发回同一个聊天。

```text
聊天 agent（/requirement-kickoff）                      流水线进程（本工具）
  访谈 → spec.md → 用户确认 → "现在开始开发吗？"
  执行 start-pipeline --origin-agent $PASEO_AGENT_ID ──►  检查条件，后台启动，立即返回
                                                        方案设计 → 方案审核 ⇄ 修订 → 实现
                                                        → 代码评审 ⇄ 修复 → 服务启动 → 验证
                                                        → 缺陷修复 ⇄ 复验 → 报告
  ◄── 需要业务决定：问题 + 继续命令 ─────────────────────┤（暂停，未写代码）
  向用户提问，更新 spec，用户确认，执行继续命令 ─────────►│（从方案设计重新开始）
  ◄── 等待权限批准 / 中断原因 + 继续命令 ─────────────────┤
  ◄── 结论 + 摘要 + report.md ──────────────────────────┘
```

每个步骤是一个新的 Paseo agent，作为子 agent 挂在发起的聊天下面，名字形如 `[20261012-sms-login] 6-代码评审 第2轮`。步骤之间通过功能目录中的文件交接；每步结束时写一个结果文件（JSON），流水线据此决定下一步。

## 安装：让所有 Paseo 对话都能使用

Paseo 在本机运行各 agent 自己的命令行工具，并沿用它们的用户级配置和 skill。所以把 skill 装进各 agent 的用户级 skill 目录，任何项目的对话里都能用 `/requirement-kickoff`（Pi 中为 `/skill:requirement-kickoff`）；流水线程序本身只需在本机装一份，所有项目共用。

需要 Node.js 22 或更新版本，以及 Paseo 0.11 或更新版本。在运行 Paseo daemon 的那台机器上：

```bash
# 1. 放到一个固定位置（之后不要再移动，skill 里会写入这个路径）
mkdir -p ~/tools
cp -r script-pipeline ~/tools/requirement-pipeline   # 在解压后的 paseo-requirement-workflow 目录中执行
cd ~/tools/requirement-pipeline
npm install

# 2. 安装依赖的 skill（grilling、domain-modeling）。Windows 上加 --copy 以免需要创建符号链接的权限
npx skills add mattpocock/skills -g --copy

# 3. 安装本工具的 skill，并检查环境
node install.mjs
```

`install.mjs` 会：

- 把 `requirement-kickoff` 安装到各 agent 的用户级 skill 目录：`~/.agents/skills`（通用目录，Codex、Pi 等使用），以及存在时的 `~/.claude/skills`（Claude Code）。Windows 上 `~` 即 `%USERPROFILE%`。其他目录可用 `--target <目录>` 追加。
- 把流水线启动命令的绝对路径写进 skill，不依赖环境变量。
- 检查 Node.js 版本、npm 依赖、配置文件，以及依赖的 skill 是否在每个目录中都已就位。缺配置文件时会从示例复制一份。

第一次运行时会提示填写配置：编辑 `pipeline.config.json` 中的 `agents`，为两个角色各选一个 agent，写法见下一节。填好后运行 `npm run smoke -- check` 核对，再运行一次 `node install.mjs`，全部显示 ✓ 即完成。

## 不同 agent 的配置

流水线有两个角色：`builder`（方案设计、实现、修复、报告）和 `reviewer`（方案审核、代码评审、功能验证）。两个角色可以用不同的 agent，用不同的模型做审核更容易发现实现方看不到的问题。

每个角色的配置项：

| 字段 | 含义 |
| --- | --- |
| `provider` | `<Paseo 中的 provider ID>/<模型 ID>`，只在第一个 `/` 处拆分 |
| `modeId` | agent 的模式。必须选不会停下来等待批准的模式；没有模式的 agent 不写 |
| `featureValues` | agent 的功能开关，目前只有 OpenCode 需要 |
| `thinkingOptionId` | 可选，思考强度，可用值取决于 agent 和模型 |

模型 ID、模式和思考强度的可用值以 `npm run smoke -- check` 列出的为准。下表来自 Paseo 0.11.2 源码：

| agent | provider ID | `provider` 写法 | 无人值守的设置 | 思考强度 |
| --- | --- | --- | --- | --- |
| Claude Code | `claude` | `claude/<模型 ID>` | `"modeId": "bypassPermissions"` | 取决于模型 |
| OpenCode | `opencode` | `opencode/<上游>/<模型 ID>` | `"modeId": "build"` 加 `"featureValues": { "auto_accept": true }` | 取决于模型（OpenCode 称为 variant） |
| Pi | `pi` | `pi/<上游>/<模型 ID>` | 不写 `modeId`（Pi 没有模式，也不会请求批准） | `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` |
| Codex | `codex` | `codex/<模型 ID>` | `"modeId": "full-access"` | 取决于模型 |

### Claude Code

```json
"builder": { "provider": "claude/<模型 ID>", "modeId": "bypassPermissions" }
```

- 模式还有 `default`（每次询问）、`acceptEdits`（只自动批准改文件）、`auto`（由模型判断是否批准）、`plan`（只读）。前三个都可能停下来等待批准，`plan` 不能改文件，都不适合流水线。

### OpenCode

```json
"builder": {
  "provider": "opencode/<上游>/<模型 ID>",
  "modeId": "build",
  "featureValues": { "auto_accept": true }
}
```

- OpenCode 的模型 ID 本身带上游前缀，例如 `anthropic/...`、`openai/...`。
- 模式就是 OpenCode 中定义的 primary agent，默认有 `build`（可以改文件、执行命令）和 `plan`（只读）。如果你在 OpenCode 里删除或改名了 `build`，换成你自己可以改文件的 agent。
- `auto_accept` 让 Paseo 自动批准 OpenCode 的权限请求。不开的话，执行命令时会停下来等待批准。冒烟测试会检查这一项。

### Pi

```json
"builder": { "provider": "pi/<上游>/<模型 ID>", "thinkingOptionId": "high" }
```

- 不要写 `modeId`，写了会被 daemon 拒绝。
- Pi 本身不请求批准；只有安装了会弹出确认的 Pi 扩展时，才可能停下来等待。

### 混用示例

```json
"agents": {
  "builder":  { "provider": "claude/<模型 ID>", "modeId": "bypassPermissions" },
  "reviewer": { "provider": "opencode/openai/<模型 ID>", "modeId": "build", "featureValues": { "auto_accept": true } }
}
```

### 用作发起对话的聊天 agent（第 1–2 步）

`install.mjs` 安装的位置对这几个 agent 都有效，但触发方式不同：

| agent | 读取 skill 的位置 | 在对话中如何触发 |
| --- | --- | --- |
| Claude Code | `~/.claude/skills` | `/requirement-kickoff 我想……` |
| OpenCode | `~/.agents/skills`（也读 `~/.claude/skills`） | `/requirement-kickoff 我想……`（skill 已声明 `opencode/slash`）；命令列表中没有时，直接说"用 requirement-kickoff 帮我整理一个需求" |
| Pi | `~/.agents/skills` | `/skill:requirement-kickoff 我想……` |
| Codex | `~/.agents/skills` | 直接说"用 requirement-kickoff 帮我整理一个需求：……"，或用 Codex 点名 skill 的方式 |

发起对话的 agent 和流水线里两个角色的 agent 互不影响，可以是任意组合。发起对话的 agent 需要能执行命令（用于启动流水线），并能访问本机网络。

**生效范围**：新开的对话立即可用，已经打开的对话需要新开一个。所有项目都不需要额外配置。

**更新**：替换 `~/tools/requirement-pipeline` 中的文件（保留 `pipeline.config.json`、`prompts.local/` 和 `node_modules`），然后重新运行 `node install.mjs`。旧版配置中顶层的 `rounds` 仍然有效，会当作标准档的轮数。用 `node install.mjs --check` 可以只检查不修改，`node install.mjs --uninstall` 删除它安装的 skill。

## 冒烟测试：在你的机器上确认能跑通

本工具的编排逻辑已在模拟环境中测试过（见文末）。下面四项依赖你的真实环境，第一次使用前请按顺序做一遍。

**1. daemon、模型和模式**（在终端运行）

```bash
npm run smoke -- check
```

会连接 daemon，核对配置中的模型和模式，再用两个角色各启动一个小 agent，确认它能写文件、能执行命令，并且不会停下来等待权限批准。

**2. 通知能否发回聊天、子 agent 能否挂到聊天下面**（在 Paseo 的聊天里）

对聊天 agent 说：

> 请在终端执行 `cd ~/tools/requirement-pipeline && npm run smoke -- notify`，然后告诉我输出。

预期：聊天里出现一条"通知通道工作正常"的转告；聊天的子 agent 列表中出现"[冒烟测试] 子 agent"。

**3. 聊天 agent 结束回合后，后台进程是否还活着**（在 Paseo 的聊天里，分两次说）

> 请执行 `cd ~/tools/requirement-pipeline && npm run smoke -- detach-start`，然后结束这一轮。

等至少一分钟，再说：

> 请执行 `cd ~/tools/requirement-pipeline && npm run smoke -- detach-check`，告诉我结果。

显示 ✓ 即可。显示 ✗ 说明你的环境会在回合结束时终止聊天 agent 启动的后台进程，需要改用插件方式启动（请告诉我）。

**4. 用一个很小的真实需求完整跑一遍**，例如"在 README 末尾加一行版权声明"。重点看各步骤产物的质量，以及最后的通知是否正常到达。

## 日常使用

### 每个需求一个 worktree 工作区（推荐）

在 Paseo 中为每个需求新建工作区：**New workspace** → 选择项目 → **Isolation** 选 **New worktree** → 起点选 `origin/main`，然后在这个工作区的对话里输入 `/requirement-kickoff`。

- 流水线在这个工作区自己的目录和分支上运行、提交，不影响项目主目录，你可以照常在主目录工作。
- 同一个目录一次只能运行一条流水线；用了 worktree，几个需求可以同时进行。
- 在主目录发起时，`/requirement-kickoff` 会先建议改用 worktree；用户坚持的话，它会新建 `feature/<功能目录名>` 分支再继续。

**分支规则**：流水线把启动时检出的分支作为本次需求的工作分支，所有步骤都提交到这里，不切换、不新建分支。它拒绝在默认分支（`main`、`master` 或 `origin/HEAD` 指向的分支）或 detached HEAD 上启动；续跑时分支变了也会拒绝。

### 档位

| 档位 | 适用 | 访谈 | 流程 |
| --- | --- | --- | --- |
| 快速（`quick`） | 小改动：文案、样式、配置项、字段显示等，不涉及数据结构、权限、对外接口 | 只问要改什么、改成什么样、不改什么、验收标准 | 审核、评审、缺陷修复各一轮；不做服务启动验证；产物从简 |
| 标准（`standard`） | 其他情况 | 完整访谈 | 审核最多 2 轮、评审最多 3 轮、缺陷修复最多 3 轮 |

`/requirement-kickoff` 会根据需求推荐档位，用户确认后写进 spec（`- 档位：快速`）。流水线按以下顺序决定档位：`--profile` 参数 → 续跑时沿用上次的档位 → spec 中的档位 → 配置中的 `defaultProfile`。各档的轮数和是否做服务启动验证可以在配置的 `profiles` 中调整。

### 在对话中查看进度、停止、继续

用户在对话里说"做到哪了""先停一下""继续开发"，聊天 agent 会执行对应的命令并用白话转告。也可以手动执行：

```bash
node ~/tools/requirement-pipeline/bin/start-pipeline.mjs --feature docs/features/<目录名> --status    # 进度
node ~/tools/requirement-pipeline/bin/start-pipeline.mjs --feature docs/features/<目录名> --stop      # 停止
node ~/tools/requirement-pipeline/bin/start-pipeline.mjs --feature docs/features/<目录名> --resume    # 继续
```

- `--status`：当前状态、正在进行的步骤和已用时间、已完成步骤的结论和用时。
- `--stop`：结束后台进程，并打断当前步骤的 agent，让它不再修改文件。已完成的步骤会保留，`--resume` 从停下的步骤重新开始。

| 情况 | 做法 |
| --- | --- |
| 需要业务决定而暂停 | 回答问题、更新并重新确认 spec 后，加 `--resume`。从方案设计重新开始 |
| 中断后继续 | 加 `--resume`。已完成的步骤沿用结果，从失败的步骤继续；如果 spec 被改过，则从方案设计重新开始 |
| 从头重跑 | 加 `--restart`，可以同时用 `--profile` 换档位 |

### 进展通知

除了"需要业务决定""等待批准""中断""完成"这几种通知，流水线默认还会在三个节点各发一句进展：技术方案已经确定、开始写代码；代码通过检查、开始验证；验证发现问题、正在修复。续跑时不会重复发送。不需要的话，在配置中设 `"notifyMilestones": false`。

### 运行时文件

运行时的文件都在功能目录下的 `.pipeline/` 中，不会被提交：

- `state.json`：当前状态、档位、工作分支、每个步骤的 agent ID 和结果、历次尝试的记录
- `results/<步骤>.json`：每个步骤的结果文件
- `pipeline.log`：运行日志，包括使用了哪些配置文件和发出的每一条通知

## 按项目定制

本机配置（工具目录下的 `pipeline.config.json`）对所有项目生效。各项目可以在仓库里放自己的定制，随代码一起提交，团队共享：

```text
<仓库根目录>/
├── .requirement-pipeline.json          覆盖本机配置中的项
└── .requirement-pipeline/
    ├── project-notes.md                追加到每个步骤的提示词；/requirement-kickoff 访谈前也会读
    └── steps/
        └── <步骤>.md                   只追加到某一步，例如 verify.md
```

**`.requirement-pipeline.json`** 可以设置除 `daemonUrl`、`daemonPasswordEnv` 以外的所有项（这两项描述的是本机，写了会被忽略并在日志中提示）。例如这个项目默认走快速档、实现用另一个模型：

```json
{
  "defaultProfile": "quick",
  "agents": { "builder": { "provider": "claude/<模型 ID>", "modeId": "bypassPermissions" } },
  "profiles": { "standard": { "rounds": { "codeReview": 2 } } }
}
```

`agents` 按角色整体替换；`profiles`、`stepTimeoutMinutes` 按项合并。

**`project-notes.md`** 写这个项目的约定，例如：

```markdown
- 包管理用 pnpm，不要用 npm。
- 不要改动 legacy/ 目录。
- 数据库变更必须写成 migrations/ 下的迁移脚本。
```

**`steps/<步骤>.md`** 的文件名用步骤 ID：`design`、`design_review`、`design_revise`、`implement`、`code_review`、`review_fix`、`service_start`、`verify`、`defect_fix`、`reverify`、`report`。例如 `steps/verify.md` 写"端到端测试用 `pnpm e2e` 运行，测试账号见 docs/test-accounts.md"。

这些内容追加在步骤任务之后，并注明"与通用要求冲突时以项目说明为准"，但"如实报告"和安全要求始终有效。

**团队统一修改某一步的提示词**：在工具目录下建 `prompts.local/`，放入与 `prompts/` 中同名的文件，就会替换随工具发布的版本。升级工具时只替换 `prompts/`，`prompts.local/` 不受影响。

## 运行规则

**步骤和轮数**（轮数按档位，在配置的 `profiles` 中调整；下面是标准档的默认值）：

| 环节 | 规则 |
| --- | --- |
| 方案审核 ⇄ 方案修订 | 最多 2 轮审核。判定"阻塞"时暂停并请业务方决定；最后一轮仍要求修改时，修订后直接进入实现 |
| 代码评审 ⇄ 评审问题修复 | 最多 3 轮评审，通过即止；轮数用完时修复后进入下一阶段 |
| 服务启动验证 | 方案设计判断项目有常驻服务、且档位开启了 `serviceStart` 时才执行 |
| 缺陷修复 ⇄ 复验 | 功能验证发现缺陷时执行，最多 3 轮，复验通过即止 |
| 完成报告 | 只要没有暂停或中断就一定执行，遗留问题写进报告 |

**结果文件**：每步必须写一个 JSON 结果文件，流水线只看它，不看 agent 的回复文字。文件缺失或格式不对时，会在同一个会话里提醒 agent 补写，最多 2 次，仍不对则判定该步骤失败。

**等待与超时**：每步有总时限（`stepTimeoutMinutes`），超时判定失败（agent 可能仍在运行，可在 Paseo 中查看）。等待被拆成每段 10 分钟，连接断开时自动重试。agent 等待权限批准时，同一个请求只通知一次，然后继续等待。

**同一个目录一次只运行一条流水线**，因为各步骤都在这个目录中修改和提交。需要并行时，为每个需求使用单独的 worktree 工作区。

## 注意事项

- **发起流水线的聊天 agent 需要能访问本机网络。** 流水线进程继承它的运行环境，需要连接 `ws://127.0.0.1:6767`。用 Codex 做聊天 agent 时，请使用 `full-access` 模式；沙箱模式可能禁止网络。
- **必须在仓库对应的项目对话中发起，对话过程中不要切换工作目录。** 步骤 agent 一律作为子 agent 挂在发起的对话下，而 Paseo 会让子 agent 使用父 agent 的工作目录，所以仓库目录必须就是这个对话的工作目录。在对话中启动时，`--repo` 默认就取对话的工作目录；两者不一致、或发起的对话已不存在时，流水线拒绝启动并说明原因。
- **步骤 agent 以免确认模式运行**，在本机拥有执行命令的权限。提示词禁止了危险操作，但这不是安全边界。请让仓库目录中不包含生产环境凭据。
- **聊天被归档时**，挂在它下面的步骤 agent 也会被归档；通知会发送失败，但流水线会继续运行到结束，结果仍可在 `report.md` 和日志中查看。
- **daemon 重启**会中断正在运行的步骤 agent。流水线会在连续 5 次无法获取状态后判定该步骤失败，之后可以用 `--resume` 继续。

## 已验证的内容

在没有真实 daemon 的环境中，用模拟的 Paseo 运行时（`test/fake-runtime.ts`）运行真实的编排代码，`npm test` 共 36 个场景全部通过：

- 一次通过；审核、评审、验证各自返工直到通过；轮数用完后继续并以"有遗留问题"结束
- 方案审核阻塞：暂停、把问题发回聊天、不写代码；更新 spec 后 `--resume` 从方案设计重新开始
- 步骤报错：通知中断原因；`--resume` 沿用已完成步骤；中断后修改了 spec 则从头开始
- 结果文件缺失或格式错误时提醒补写；始终不写则判定失败
- 权限等待只通知一次；步骤超时；没有发起聊天；通知发送失败
- 默认分支、detached HEAD 上拒绝启动，续跑时分支变化拒绝；提示词带上工作分支和档位
- `--status` 在未启动、运行中、已完成时的输出；`--stop` 结束进程、打断当前步骤 agent、释放锁，之后可续跑
- 快速档的步骤和轮数；档位来自 spec、续跑沿用、`--profile` 优先
- 项目配置覆盖本机配置并忽略机器相关项；项目说明和按步骤说明追加到正确位置；`prompts.local/` 替换同名提示词
- 进展通知按节点各发一次，续跑不重复；可关闭
- 启动前检查：spec 未确认、目录越界、同目录已有流水线、配置错误
- 发起对话的工作目录与仓库目录不一致、或对话已不存在时拒绝启动，不留下运行记录；续跑时重新校验；新建 agent 的工作目录不对时立即停止并报错（见下方"注意事项"）
- 只传 `--feature` 时，从 Paseo 提供的环境变量中识别发起对话和仓库目录；安装脚本正确写入启动路径、卸载时只删除自己安装的内容
- 启动器在 bash 退出前返回，流水线在独立会话中运行到结束，并且不再是启动方的子孙进程。Paseo 关闭 agent 时按进程树终止子进程，所以不会波及流水线

另外，用 Paseo 0.11.2 的 SDK 源码对全部代码做了类型检查，没有错误（并确认了这项检查能发现故意写错的字段名和取值）。

**没有在真实环境中验证的**：真实 daemon 和 provider 的行为、子 agent 挂载、通知的实际效果、各步骤提示词的产出质量。冒烟测试的四项就是为这些准备的。
