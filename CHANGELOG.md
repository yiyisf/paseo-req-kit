# 更新记录

每个版本分为"使用者会看到的变化"和"升级须知"。升级步骤见 [docs/guide/安装与升级.md](docs/guide/安装与升级.md)。

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
