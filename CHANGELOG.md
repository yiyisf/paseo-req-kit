# 更新记录

每个版本分为"使用者会看到的变化"和"升级须知"。升级步骤见 [docs/guide/安装与升级.md](docs/guide/安装与升级.md)。

## 未发布

- **一键安装**：`curl -fsSL https://raw.githubusercontent.com/yiyisf/paseo-req-kit/main/install.sh | sh`（macOS、Linux、Git Bash、WSL），Windows PowerShell 用 `irm …/install.ps1 | iex`。一条命令完成检查环境、安装（npm 上没有时用 GitHub Release 的安装包，npm 全局目录不可写时装到 `~/.req-kit/npm`）、`req setup` 和配置向导，再次运行即升级。
- **产品站点**：https://yiyisf.github.io/paseo-req-kit/ ，包括首页、快速开始、工作原理、分阶段执行、命令和配置参考，以及由仓库文档生成的指南、文件约定、设计决定和更新记录（`site/`，VitePress）。
- **paseo.json 跨系统**：Paseo 在各系统上用不同的 shell 执行 `paseo.json` 的命令（macOS/Linux：bash、sh；Windows：准备命令用 PowerShell，脚本和服务用 cmd.exe），之前按 bash 写的命令（`$PASEO_PORT`、`[ -f … ] && cp …`）在 Windows 上会失败。`/req-setup` 现在只写各系统一样的命令，并在项目中写入两个小脚本 `scripts/paseo/with-port.mjs`（服务端口）和 `scripts/paseo/copy-local-files.mjs`（复制本地配置）；`/req-doctor` 按本机系统检查 `paseo.json`，在本机会失败的写法给出警告，只在某个系统能用的写法给出提示。已经用 `/req-setup` 生成过 `paseo.json` 的项目，再运行一次即可更新。

## 1.7.0-beta.2

分阶段执行：研发和测试验证可以分开进行。

### 使用者会看到的变化

- **提测说明**：代码评审之后新增一步，写 `handoff.md`：这次改了什么、怎么跑起来、自测结果、建议重点测试、已知问题、测试前要准备什么。功能验证会先读它。
- **执行方式**：标准档的需求在确定档位时可以选（团队或项目配置里定好了就不问）：
  - **连续**（默认，与之前一样）：研发完成后接着做测试验证。
  - **分阶段**：研发完成后停下来通知"研发完成，可以提测"；你或测试同事说"开始测试验证"再开始，也可以预约时间（`--verify-at`）。一天没有开始会提醒一次。
  - **只做研发**：做到提测说明和研发报告为止，验收时按提测说明人工测试；之后仍可以让流水线做测试验证。
- **测试验证的做法**：开始测试时可以选在本地验证，还是在已部署的测试环境中验证（AI 会和你一起写 `test-env.md`，只写口令在哪里取）；发现缺陷时当场修复、退回研发修复后再提测，或只记录。测试阶段也可以换一个 agent（例如测试同事习惯的 profile）。
- **测试同事接手**：用"开发时自动新建工作区"开发的需求，研发完成后，测试同事可以在这个项目任何工作区的对话里输入 `/req 开始测试验证 <需求名称>` 接手，之后的通知发到他的对话。
- **进度和总览**：显示"研发完成，待测试验证"，总览把它归入"需要处理"；用时与用量按阶段分别统计。终端里新增 `req verify <需求>`。
- **外部通知**：新增事件类型 `phase_done`（带提测说明的路径和开始测试验证的命令），可以直接通知测试同事。

### 升级须知

- 所有运行（包括连续方式）多了"提测说明"一步，通常几分钟；新增步骤超时 `stepTimeoutMinutes.handoff`（30 分钟）。
- 新的可选配置 `phases`（`mode`、`verify.environment`、`verify.agents`、`verify.defects`、`verify.serviceStart`），默认值保持原来的行为；spec 头部可选的新行 `- 执行方式：`；启动参数 `--phases`、`--phase verify`、`--verify-at`、`--verify-env`、`--defects`。
- 状态文件新增可选字段和状态值 `phase_done`，格式版本仍为 1。回滚到 1.7.0-beta.1 或更早版本后，旧引擎把"研发完成，待测试验证"当作可以继续的中断，继续时沿用研发结果、直接做验证。
- 外部通知模块：新事件类型 `phase_done`；只订阅了部分事件（`events`）的不受影响。`notifiers/im-template.mjs` 已加上它的标题。
- 自定义了 `prompts.local/` 的：新增提示词 `07b-handoff.md`、`verify-deployed.md`；`09-verify.md`、`11-report.md`、`incremental.md` 有增补，覆盖过它们的请对照合并。
- 评估：新增用例 `text-utils-tb-gated`，检查研发完成后停在闸口并写了提测说明。设计决定见 ADR 0022。
- 发布：1.7.0-beta.1 的发布工作流因类型检查失败没有发布到 npm（新建工作区时传了 Paseo 0.11.2 还不认识的 `background` 选项，已去掉；之前不会影响运行），1.7.0-beta.2 包含它的全部内容。新增 `ci.yml` 在推送到 main 时先跑一遍检查；第一次发布到 npm 在本机手工进行，之后用可信发布（见维护者指南）。

## 1.7.0-beta.1

npm 分发：`npm i -g paseo-req-kit` 安装，按本机 Paseo 的版本升级。

### 使用者会看到的变化

- **用 npm 安装**：`npm i -g paseo-req-kit`，然后 `req setup`、`req configure`。Windows 上 `req` 命令由 npm 放进 PATH，不用再手工设置。全局安装的是一个版本管理器：各版本仍装在 `~/tools/req-kit/versions/<版本>`，正在运行的流水线不受升级影响。
- **按 Paseo 版本升级**：`req upgrade` 先读本机 Paseo daemon 的版本，只升级到能支持它的 req-kit，并说明跳过了哪些版本、为什么。`req upgrade --beta` 在正式版上也考虑 beta 版。
- **新命令**：`req versions`（已安装的版本和 npm 上的版本）、`req use <版本>`（切换或回滚）、`req setup`。也提供同名命令 `req-kit`，避免和其他工具的 `req` 冲突。
- **体检**：显示本机 Paseo 的版本，以及它是否在当前 req-kit 支持的范围内。
- **发布**：每个版本发布到 npm（beta 版用 `beta` 标签），正式版另有 `paseo-<小版本>` 标签（如 `npm i -g paseo-req-kit@paseo-0.11`）；GitHub Release 附带离线安装包。

### 升级须知

- 已用 git 安装的机器可以照旧 `req upgrade`（来源仍是 git）；想改用 npm：`npm i -g paseo-req-kit` 后 `req setup`，原有的 git 版本保留在 `versions/` 中，可以 `req use` 切回。
- `req upgrade --from` 现在接受 `npm`、`git` 或 git 地址。
- 依赖查找改为按 Node 的方式向上查找（npm 安装时依赖在 `versions/<版本>/node_modules`）。
- 维护者：发布改由 GitHub Actions 完成（`.github/workflows/release.yml`），需要先在 npmjs.com 上把仓库登记为可信发布者，见维护者指南。设计决定见 ADR 0021。
- 状态文件和配置没有变化。

## 1.6.0-beta.1

调度：预约开始、等待提醒、中断后自动继续、排队，以及需求总览。

### 使用者会看到的变化

- **预约开始**：确认需求后可以说"今晚 10 点开始"或"明天早上开始"。流水线用 Paseo 定时任务预约，到时在这个对话里自动执行启动命令；在那之前修改需求说明也没关系。查看进度能看到预约，说"先停一下"即可取消。
- **等待提醒**：方案审核提出需要你决定的问题后，如果 24 小时内没有回答，会在对话里提醒一次（`waitingReminderHours`）。
- **中断后自动继续**：因限流、网络中断等临时错误中断（已自动重试过）时，预约 30 分钟后在对话里自动继续，每次尝试最多 2 次（`autoResumeMinutes`、`autoResumeMax`）。中断通知会写明预约的时间；说"先停一下"可以取消。
- **排队**：可以限制一台机器上同时运行的流水线数量（`maxConcurrentPipelines`，默认不限）。满了的时候新的需求会排队，并在对话里说明前面在跑哪些；轮到时自动开始。查看进度会显示"排队中"。
- **定时检查（可选，默认关闭）**：开启 `watchdogMinutes` 后，运行期间对话会定时检查一次，发现后台进程意外退出（例如机器重启）时自动继续。
- **需求总览**：`req digest` 列出项目中的需求，按"需要处理、待验收、开发中、对齐中、已验收"分组；`req digest --notify` 发到外部通知（如企业 IM，新的事件类型 `digest`）；`req digest --schedule "0 9 * * 1"` 让 Paseo 每周一 9 点自动发送。

### 升级须知

- 新的可选配置：`maxConcurrentPipelines`（0）、`queuePollSeconds`（60）、`waitingReminderHours`（24）、`autoResumeMinutes`（30）、`autoResumeMax`（2）、`watchdogMinutes`（0）。提醒和自动继续默认开启，不需要时设为 0。现有配置无需改动。
- 新的启动参数 `--at`；新命令 `req digest`。
- 外部通知新增事件类型 `digest`。通知模块配置了 `events` 列表的不会收到它；没有配置 `events` 的会收到，按 `contracts/notifier-event.md` 的约定，模块应忽略不认识的类型（模板已处理）。
- 状态文件增加可选字段 `schedules`、`autoResumes`、`queuedSince`（格式版本仍为 1）。
- 这些功能使用 Paseo 的定时任务（经由内部客户端，见 ADR 0020）；Paseo 不支持时自动关闭，并在输出中说明。
- 设计决定见 ADR 0020。

## 1.5.0-beta.1

并行编排：确认前的独立审阅、方案提案、浏览器验证，以及可选的"自动新建工作区"。

### 使用者会看到的变化

- **确认前独立审阅需求说明**：标准档的需求在请你确认之前，会先请另一个模型（配置的 reviewer）在后台独立审一遍草稿，找出歧义、遗漏、没法验证的验收标准和矛盾，每个问题写成带推荐的选择题（`spec-review.md`）。几分钟后结果发回对话，AI 核对后再逐个问你。快速档默认不做。
- **自动新建工作区（可选）**：在项目主目录、主分支上提需求时，`/req` 多了一个选项"开发时自动新建工作区"：照常在这个对话里谈需求，启动开发时流水线为这个需求新建一个 worktree 工作区（分支 `feature/<功能目录名>`），把需求说明移过去提交，在那里开发；步骤仍然挂在这个对话下，对话的目录不变，之后的进度、暂停、继续、验收都在这里说。`paseo.json` 的环境准备会自动执行。
- **方案提案（可选，默认关闭）**：开启后，标准档的方案设计之前由几个 agent（默认 builder 和 reviewer）并行各提一份方案，方案设计步骤比较后决定，`design.md` 中多一节"方案比较"。
- **浏览器验证**：在 Paseo 设置中打开 Paseo 工具和浏览器工具后，功能验证、缺陷修复、复验步骤会用 Paseo 内置浏览器按验收标准实际操作网页，你可以在桌面端实时看到；截图在对应步骤 agent 的对话记录里。

### 升级须知

- 新的可选配置：`specReview`（`"standard"` 默认 / `"always"` / `"off"`）、`designProposals`（默认 `{"enabled": false, "profiles": ["standard"], "members": []}`）、`browserVerify`（`"auto"` 默认 / `"off"`）；`stepTimeoutMinutes` 增加 `spec_review`（20）、`design_proposal`（45）。现有配置无需改动。
- 新的启动参数：`--spec-review`、`--worktree`。`/req` 的新需求手册增加了"独立审阅"一步，以及在主分支上"自动新建工作区"的选项；已经打开的对话请新开一个才能用到新手册。
- 新增步骤提示词 `02-spec-review.md`、`03a-design-proposal.md`、`browser-verify.md`；已有提示词没有改动。
- 状态文件增加可选字段 `worktree`（格式版本仍为 1）。用"自动新建工作区"启动的需求回滚到 1.4 之后，要在新工作区的对话中继续。
- 修复：`req resume <名称的一部分>` 等简写在 1.3 中会让后台进程找不到功能目录，现在启动器把解析后的参数传给后台进程。
- 设计决定见 ADR 0018（自动新建工作区，补充 0001、0002）、ADR 0019（并行编排）。

## 1.4.0-beta.1

用好 Paseo 本身的能力（第一批）：agent profiles、paseo.json 与受 Paseo 管理的服务、额度提醒、实时活动。

### 使用者会看到的变化

- **用 Paseo 的 agent profile 配置 agent**：配置中可以写 `"builder": { "paseoProfile": "实现" }`，引用在 Paseo 设置 → Agents → Agent profiles 中建好的 profile。之后换模型、改模式只需在 Paseo 中修改 profile，下一次运行生效。配置向导会先列出已有的 profile 供选择；写在 `paseoProfile` 旁边的字段优先于 profile 中的设置。
- **服务由 Paseo 管理**：项目的 `paseo.json` 中定义了服务（`"type": "service"`）时，流水线在服务启动验证、功能验证、缺陷修复和复验之前，通过 Paseo 带着当前代码重启这些服务，把地址交给步骤 agent，验证结束后停止。Paseo 为每个 worktree 分配独立端口，几个需求同时验证不会端口冲突。服务没有启动成功时，最后的输出会写到 `.pipeline/services/<服务名>.log` 交给步骤。
- **`/req-setup` 生成 `paseo.json`**：新建 worktree 时自动安装依赖、复制本地配置（如 `.env`），并把常驻服务定义为监听 `$PASEO_PORT` 的服务。
- **额度提醒**：开始前读取 Paseo 的用量信息，所用 agent 的订阅额度用到 85% 以上时，在对话里提醒一次（不阻止运行）。
- **"做到哪了"更具体**：运行中查看进度时，会附上当前步骤 agent 最近几分钟在做什么（运行了什么命令、改了哪些文件），从 Paseo 实时读取。
- **体检**：显示 Paseo 中的 agent profile 和引用的解析结果、Paseo 工具和浏览器工具是否开启、各 agent 的额度；检查项目的 `paseo.json`（服务是否使用 `$PASEO_PORT`、是否已提交）。

### 升级须知

- 新的可选配置：`paseoServices`（`"auto"` 默认 / `"off"`）、`serviceReadySeconds`（默认 120）、`quotaWarnPercent`（默认 85，0 关闭）；角色和评审小组成员可以用 `paseoProfile` 代替 `provider`。现有配置无需改动。
- 新增步骤提示词 `paseo-services.md`（只在服务由 Paseo 管理时附加）；`08-service-start.md`、`09-verify.md` 增加了"服务由 Paseo 管理时"的说明。用 `prompts.local/` 整篇替换过这两篇的，请对比新版。
- `/req-setup` 有更新：已接入的项目可以再运行一次，生成 `paseo.json`。
- 管理服务用到了 `@getpaseo/client` 0.11 导出的内部客户端（公开 API 还没有工作区脚本），见 ADR 0017；Paseo 版本不支持时自动退回到"步骤 agent 自己启动服务"。
- 状态文件格式没有变化。

## 1.3.0-beta.1

便利性与可靠性：配置向导、一键升级、`req` 命令、需求变更后增量继续、临时错误自动重试、用时与用量，以及接入企业 IM 的通知接口。

### 使用者会看到的变化

- **需求变更后增量继续**：修改需求、回答了方案审核的问题、验收不通过后继续开发时，在已有方案和代码的基础上只处理变化的部分（方案追加"第 N 次尝试"一节，评审只看本次的改动，验证重点验变化的验收标准并回归其余的），通常比第一次快很多。要完全从零开始仍用 `--restart`。
- **临时错误自动重试**：限流（429）、服务暂时不可用、网络中断等临时错误，自动等待后重试（默认最多 2 次，间隔 1 分钟、5 分钟），重试的步骤会被告知工作区里可能有上次没做完的改动。重试用完仍失败才中断。
- **用时与用量**：查看进度、需求总览和完成报告中显示各步骤 agent 合计用时，以及 agent 报告的 token 用量和费用（有的 agent 不报告）。
- **`req` 命令**：在终端中用短命令查看和操作需求：`req list`、`req status`、`req stop sms-login`、`req resume sms-login`、`req doctor`、`req upgrade` 等，`req help` 查看全部。需求可以只写名称中能唯一确定的一部分；只有一个需求运行过时 `req status` 不用写名称。
- **配置向导**：`req configure`（或 `node install.mjs --configure`）列出 Paseo 中可用的 agent、模型，自动选择不需要确认的运行模式，几个选择题即可写好配置，不再需要手工编辑 JSON。
- **一键升级**：`req upgrade` 下载最新版本、安装依赖并切换；`req upgrade 1.3.0` 指定版本；`req upgrade --check` 只看有没有新版本。`/req-doctor` 会提示有新版本。
- **外部通知接口**：可以在"需要你决定""等待批准""开发中断""已完成"和进展时刻，调用本机的通知模块，例如转发到企业内部 IM。req-kit 只提供接口和模板（`notifiers/im-template.mjs`），具体发送由使用方实现；`req notify-test` 发测试消息。

### 升级须知

- 本次可以用新的方式升级，也可以照旧手工升级。从 1.2 升级时 1.2 还没有 `--upgrade`，请按 [安装与升级](docs/guide/安装与升级.md) 第 6 节手工升级一次，之后就可以用 `req upgrade`。
- 安装时会在 `~/.req-kit/bin` 写入 `req` 命令（Windows 为 `req.cmd`）。是否加入 PATH 由你决定，安装输出中给出了命令。
- 新的可选配置：`retry`（临时错误重试，默认 `{"attempts": 2, "backoffSeconds": [60, 300]}`，设 `attempts` 为 0 关闭）、`notifiers`（外部通知，默认为空；只在本机或团队配置中有效，项目配置中的会被忽略）。现有配置无需改动。
- 新增步骤提示词 `incremental.md`（只在增量继续时附加）；`11-report.md` 增加了"用时与用量"。用 `prompts.local/` 整篇替换过 `11-report.md` 的，请对比新版。
- 状态文件增加了可选字段 `incremental` 和步骤记录中的 `usage`，格式版本仍为 1：回滚到 1.2 后可以继续已有的流水线（只是不再增量）。
- 新的文件格式约定：[contracts/notifier-event.md](contracts/notifier-event.md)（通知事件，`schema: 1`）。设计决定见 ADR 0014–0016。

## 1.2.0-beta.1

第三阶段（质量与分发）：评审小组、复盘、评估体系和团队配置。

### 使用者会看到的变化

- 开启评审小组后，标准档的方案审核和代码评审第一轮由几位评审者（可以是不同的模型）独立评审，再由评审者核实汇总。完成报告会列出被驳回的意见和留给人决定的事项。默认关闭。
- 新增 `/req-retro`（复盘）：需求完成、中断或验收不通过后，找出问题和根因，按"能用机器挡住的不写进文档"的顺序提出改进，批准后落地。验收手册在验收不通过时会提示复盘。
- 需求总览在 Windows 上能正确标出"当前工作区"。
- 产物文件统一要求 UTF-8 编码；步骤提示词提醒不要用 Windows PowerShell 的重定向写文件（会变成 UTF-16）。

### 升级须知

- 新的可选配置：`teamConfig`（只在本机配置中有效，指向团队配置文件）、`requiredVersion`（版本要求，只提醒不阻止）、`reviewPanel`（评审小组，默认关闭）。现有配置无需改动。
- 新增步骤提示词 `panel-member.md`；`00-shared-context.md` 增加了编码要求。用 `prompts.local/` 整篇替换过 `00-shared-context.md` 的，请对比新版。
- 新增评估：`npm run eval:self-check`（不需要 Paseo）和 `npm run eval`（真实运行流水线）。见 `evals/README.md`。
- 新增 [维护者指南](docs/guide/维护者指南.md)：改动规则和发布流程。
- 状态文件格式没有变化。

## 1.1.0-beta.1

第二阶段（生命周期）：需求从提出到验收、上线后问题、接手的完整过程。

### 使用者会看到的变化

- `/req` 新增四本手册：
  - **修改需求**：只谈变化的部分，需求说明版本加 1，变更记入 `changes.md`；已经完成的需求改完后也能继续开发，从方案设计重新开始。
  - **验收**：按验收标准逐条核对，能用命令验证的给出命令，结果记入 `acceptance.md`；不通过的项可以转为修改继续开发。
  - **上线后发现问题**：问清现象、复现步骤和影响，关联原需求，生成缺陷说明后按快速档修复。
  - **接手**：列出项目中所有工作区的需求，讲清某个需求的现状、待决事项和下一步。
- 完成报告新增"需要你确认的决定"：汇总各步骤中会影响结果的假设、取舍和被驳回的评审意见（来自新的决策记录 `decisions.tsv`）。
- 验证结果写明每条验收标准的证据（命令及关键输出、截图或日志路径）。
- 新增 `/req-setup`：为项目生成项目说明和验证方法（`verify.md`，其中的命令实际运行过）。接入后，实现、服务启动和验证步骤按它执行，更快也更稳定。

### 升级须知

- 建议每个项目运行一次 `/req-setup`，提交生成的 `.requirement-pipeline/verify.md` 和 `project-notes.md`。不运行也能使用，`/req-doctor` 会提示。
- 流水线完成后，如果 spec.md 被修改过，`--resume` 会从方案设计重新开始（以前要求用 `--restart`）。spec 没改时仍然拒绝。
- 新增 `start-pipeline --list`：列出这个仓库所有 worktree 中的需求。设计方案中的 `docs/features/INDEX.md` 改为现场生成，不提交，见 ADR 0010。
- 步骤提示词有改动（决策记录、验证方法、证据要求）。用 `prompts.local/` 整篇替换过提示词的，请对比新版。
- 状态文件格式没有变化。
- 版本标签不带 `v` 前缀，例如 `1.1.0-beta.1`。

## 1.0.0-beta.1

第一阶段（骨架）。由"需求对齐 skill + 脚本流水线"（paseo-requirement-workflow）演进而来。

### 使用者会看到的变化

- 入口改为 `/req`（Pi 中为 `/skill:req`）。`/req` 会判断你想做什么：提新需求、做小改动、查看进度、暂停或继续。旧入口 `/requirement-kickoff` 仍然可用，会提示改用 `/req`。
- 小改动有了专门的流程：只问 2–3 个关键问题，走快速档。
- 访谈面向有一定技术背景的使用者：可以直接谈接口、字段、测试用例；会追问异常流程、测试数据和验证环境。
- 验收标准写成"前置条件 / 操作 / 预期结果"，测试同事可以直接转成用例。
- 完成报告写明每条验收标准的证据（运行的命令、输出、截图路径），方便自己复核。
- 新增 `/req-doctor`：检查安装、配置、Paseo 和当前项目，列出要处理的问题和修复方法。

### 升级须知

- **安装方式变了**：程序放在 `~/tools/req-kit/versions/<版本>/`，本机配置放在 `~/.req-kit/config.json`。从脚本版迁移时运行 `node install.mjs --import-legacy ~/tools/requirement-pipeline`，它会导入旧配置和 `prompts.local/`，并替换旧的 `requirement-kickoff`。
- **不再需要** Matt Pocock 的 `grilling`、`domain-modeling` skill，可以保留或自行卸载。
- 项目中的 `.requirement-pipeline.json`、`.requirement-pipeline/` 和 `docs/features/` 无需改动。旧的状态文件（没有 `version` 字段）按第 1 版读取。
- 新的术语写入 `GLOSSARY.md`；已有的 `CONTEXT.md` 会继续读取，是否合并由开发同事决定。
- 每个步骤的提示词现在包含"工作原则"一节（`principles/INDEX.md`）。用 `prompts.local/` 整篇替换过 `00-shared-context.md` 的，请对比新版。
- Paseo Hub 版本移到 `legacy/hub-workflow/`，不再维护。
