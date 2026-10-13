# 更新记录

每个版本分为"使用者会看到的变化"和"升级须知"。升级步骤见 [docs/guide/安装与升级.md](docs/guide/安装与升级.md)。

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
