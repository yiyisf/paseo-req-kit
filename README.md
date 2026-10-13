# paseo-req-kit

req-kit 是运行在 [Paseo](https://paseo.sh) 上的一套需求开发体系，帮助非专职开发、但有一定技术背景的同事（测试、产品经理、项目经理等）把一个需求从对齐做到可验收：

- 在对话中输入 `/req`，用访谈的方式把需求谈清楚，生成并确认一份需求说明（`spec.md`）。
- 确认后，引擎在后台按固定顺序驱动一组 Paseo agent：方案设计 → 方案审核 ⇄ 修订 → 代码实现（适合时 TDD）→ 代码评审 ⇄ 修复 →（有常驻服务时）服务启动验证 → 功能验证 →（发现缺陷时）缺陷修复 ⇄ 复验 → 完成报告。
- 进展、需要决定的问题和最终结论都发回同一个对话；每个步骤以子 agent 的形式挂在对话下。只做本地提交，合并上线由人决定。

当前版本：**1.1.0-beta.1**（第二阶段：生命周期）。变化见 [CHANGELOG.md](CHANGELOG.md)。

## 体系结构

| 层 | 内容 | 位置 |
| --- | --- | --- |
| 入口 | `/req`（使用者入口，七本手册：新需求、小改动、进度/暂停/继续、修改需求、验收、上线后问题、接手）；`/req-setup`（项目接入）；`/req-doctor`（体检） | `skills/req/`、`skills/req-setup/`、`skills/req-doctor/` |
| 方法 | 需求访谈、需求说明、验收标准、结果说明 | `skills/requirement-interview/`、`skills/spec-writing/`、`skills/acceptance-criteria/`、`skills/result-report/` |
| 原则 | 七条工作原则，聊天和引擎共用一份索引 | `principles/INDEX.md`、`skills/principle-*/` |
| 引擎 | 第 3–11 步的流水线程序和步骤提示词 | `engine/` |

入口之间不互相调用；引擎不调用 skill，只读取提示词和原则索引。设计决定见 [docs/adr/](docs/adr/)，文件格式见 [contracts/](contracts/)，范围见 [SCOPE.md](SCOPE.md)。

## 快速开始

在运行 Paseo daemon 的机器上（需要 Node.js 22+）：

```bash
git clone --branch 1.1.0-beta.1 --depth 1 https://github.com/yiyisf/paseo-req-kit ~/tools/req-kit/versions/1.1.0-beta.1
cd ~/tools/req-kit/versions/1.1.0-beta.1
npm install
node install.mjs          # 已装过脚本版的，加 --import-legacy ~/tools/requirement-pipeline
```

然后编辑 `~/.req-kit/config.json`，为 `builder` 和 `reviewer` 各选一个 agent：

| agent | 配置 |
| --- | --- |
| Claude Code | `{ "provider": "claude/<模型 ID>", "modeId": "bypassPermissions" }` |
| Codex | `{ "provider": "codex/<模型 ID>", "modeId": "full-access" }` |
| OpenCode | `{ "provider": "opencode/<上游>/<模型 ID>", "modeId": "build", "featureValues": { "auto_accept": true } }` |
| Pi | `{ "provider": "pi/<上游>/<模型 ID>" }`（不写 `modeId`） |

再运行一次 `node install.mjs`，然后 `node bin/req-doctor.mjs --no-project` 检查 daemon 和 agent，并按指南做冒烟测试。

每个项目建议先在项目根目录的对话中运行一次 `/req-setup`。之后在任意项目的 Paseo 对话中输入 `/req 我想……`（Pi 中为 `/skill:req`）。

## 文档

| 读者 | 文档 |
| --- | --- |
| 使用者 | [使用者指南](docs/guide/使用者指南.md) |
| 安装和维护的人 | [安装与升级](docs/guide/安装与升级.md)：安装、各 agent 配置、冒烟测试、升级、回滚、从脚本版迁移、卸载 |
| 项目维护者 | [项目定制与运行规则](docs/guide/项目定制与运行规则.md)：项目配置、项目说明、档位、运行规则、注意事项 |
| 体系维护者 | [docs/adr/](docs/adr/)、[contracts/](contracts/)、[SCOPE.md](SCOPE.md)、[.out-of-scope/](.out-of-scope/) |

## 开发

```bash
npm test            # 引擎场景测试（模拟 Paseo）、安装器、体检、skill 校验
npm run typecheck
```

引擎的编排逻辑用模拟的 Paseo 运行时（`engine/test/fake-runtime.ts`）运行真实代码来测试；安装器和体检在临时的 HOME 中测试。真实 daemon 和 agent 的行为、提示词的产出质量需要通过冒烟测试和真实需求确认。

## 目录

```text
skills/            安装到各 agent 的 skill（入口、方法、原则、旧入口的引导）
principles/        原则索引
engine/            流水线引擎：src/ 程序、prompts/ 步骤提示词、test/ 测试
bin/               start-pipeline.mjs（启动器）、req-doctor.mjs（体检）
install.mjs        安装、升级、回滚、卸载
contracts/         spec、状态文件、结果文件的格式约定
docs/              使用指南与设计决定
test/              安装器、体检、skill 的测试
legacy/            不再维护的 Hub 工作流版本
```
