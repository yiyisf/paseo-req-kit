# paseo-req-kit

req-kit 是运行在 [Paseo](https://paseo.sh) 上的一套需求开发体系，帮助非专职开发、但有一定技术背景的同事（测试、产品经理、项目经理等）把一个需求从对齐做到可验收：

- 在对话中输入 `/req`，用访谈的方式把需求谈清楚，生成并确认一份需求说明（`spec.md`）。
- 确认后，引擎在后台按固定顺序驱动一组 Paseo agent：方案设计 → 方案审核 ⇄ 修订 → 代码实现（适合时 TDD）→ 代码评审 ⇄ 修复 →（有常驻服务时）服务启动验证 → 功能验证 →（发现缺陷时）缺陷修复 ⇄ 复验 → 完成报告。
- 进展、需要决定的问题和最终结论都发回同一个对话；每个步骤以子 agent 的形式挂在对话下。只做本地提交，合并上线由人决定。

当前版本：**1.7.0-beta.2**（分阶段执行：研发完成后可以停下来提测，再由人或测试同事开始测试验证；1.7.0-beta.1 起可用 `npm i -g paseo-req-kit` 安装）。1.4–1.6 让 req-kit 用上了 Paseo 自身的能力：agent profile、`paseo.json` 服务、并行子 agent、内置浏览器和定时任务，见 [CHANGELOG.md](CHANGELOG.md)。

## 体系结构

| 层 | 内容 | 位置 |
| --- | --- | --- |
| 入口 | `/req`（使用者入口，七本手册：新需求、小改动、进度/暂停/继续、修改需求、验收、上线后问题、接手）；`/req-setup`（项目接入）；`/req-doctor`（体检）；`/req-retro`（复盘） | `skills/req/`、`skills/req-setup/`、`skills/req-doctor/`、`skills/req-retro/` |
| 方法 | 需求访谈、需求说明、验收标准、结果说明 | `skills/requirement-interview/`、`skills/spec-writing/`、`skills/acceptance-criteria/`、`skills/result-report/` |
| 原则 | 七条工作原则，聊天和引擎共用一份索引 | `principles/INDEX.md`、`skills/principle-*/` |
| 引擎 | 第 3–11 步的流水线程序和步骤提示词；可选的评审小组 | `engine/` |
| 评估 | 样例仓库与隐藏验收测试、端到端评估运行器、对话评估剧本与评分规则 | `evals/` |

入口之间不互相调用；引擎不调用 skill，只读取提示词和原则索引。设计决定见 [docs/adr/](docs/adr/)，文件格式见 [contracts/](contracts/)，范围见 [SCOPE.md](SCOPE.md)。

## 快速开始

在运行 Paseo daemon 的机器上（需要 Node.js 22+）：

```bash
npm i -g paseo-req-kit        # beta 版：npm i -g paseo-req-kit@beta
req setup                     # 装进 ~/tools/req-kit/versions/<版本>，安装 skill，生成本机配置
req configure                 # 配置向导：从 Paseo 中可用的 agent 和模型里选择
```

不用 npm 全局安装时，也可以用 git 安装（见[安装与升级](docs/guide/安装与升级.md)第 3 节）：

```bash
git clone --branch 1.7.0-beta.2 --depth 1 https://github.com/yiyisf/paseo-req-kit ~/tools/req-kit/versions/1.7.0-beta.2
cd ~/tools/req-kit/versions/1.7.0-beta.2 && npm install && node install.mjs && node install.mjs --configure
```

配置向导会为 `builder` 和 `reviewer` 各选一个 agent，并自动选择不需要确认的模式；Paseo 中建有 agent profile 时，推荐直接引用它（`{ "paseoProfile": "实现" }`），之后在 Paseo 中改 profile 即可换模型。也可以手工编辑 `~/.req-kit/config.json`：

| agent | 配置 |
| --- | --- |
| Claude Code | `{ "provider": "claude/<模型 ID>", "modeId": "bypassPermissions" }` |
| Codex | `{ "provider": "codex/<模型 ID>", "modeId": "full-access" }` |
| OpenCode | `{ "provider": "opencode/<上游>/<模型 ID>", "modeId": "build", "featureValues": { "auto_accept": true } }` |
| Pi | `{ "provider": "pi/<上游>/<模型 ID>" }`（不写 `modeId`） |

然后运行 `req doctor --no-project` 检查 daemon 和 agent，并按指南做冒烟测试。升级用 `req upgrade`（自动选能支持本机 Paseo 的版本），回滚用 `req use <版本>`。

安装器还会在 `~/.req-kit/bin` 写入 `req` 命令（按提示加入 PATH 后可直接使用）：`req list`、`req status`、`req doctor`、`req upgrade`（一键升级）、`req digest`（需求总览）等，`req help` 查看全部。

每个项目建议先在项目根目录的对话中运行一次 `/req-setup`。之后在任意项目的 Paseo 对话中输入 `/req 我想……`（Pi 中为 `/skill:req`）。

## 文档

| 读者 | 文档 |
| --- | --- |
| 使用者 | [使用者指南](docs/guide/使用者指南.md) |
| 安装和维护的人 | [安装与升级](docs/guide/安装与升级.md)：安装、各 agent 配置、冒烟测试、升级、回滚、从脚本版迁移、卸载 |
| 项目维护者 | [项目定制与运行规则](docs/guide/项目定制与运行规则.md)：项目配置、项目说明、档位、运行规则、注意事项 |
| 体系维护者 | [维护者指南](docs/guide/维护者指南.md)、[evals/](evals/README.md)、[docs/adr/](docs/adr/)、[contracts/](contracts/)、[SCOPE.md](SCOPE.md)、[.out-of-scope/](.out-of-scope/) |

## 开发

```bash
npm test                  # 引擎场景测试（模拟 Paseo）、安装器、体检、skill 校验、评估用例自检
npm run typecheck
npm run eval:self-check   # 评估用例的参考实现能否通过隐藏验收（不需要 Paseo）
npm run eval              # 用真实的 Paseo 和 agent 跑端到端评估
```

引擎的编排逻辑用模拟的 Paseo 运行时（`engine/test/fake-runtime.ts`）运行真实代码来测试；安装器和体检在临时的 HOME 中测试。真实 daemon 和 agent 的行为、提示词的产出质量需要通过冒烟测试和真实需求确认。

## 目录

```text
skills/            安装到各 agent 的 skill（入口、方法、原则、旧入口的引导）
principles/        原则索引
engine/            流水线引擎：src/ 程序、prompts/ 步骤提示词、test/ 测试
bin/               start-pipeline.mjs（启动器）、req-doctor.mjs（体检）、req.mjs（req 命令）
notifiers/         外部通知（企业 IM 等）模板，由使用方实现
install.mjs        安装、升级、回滚、卸载
contracts/         spec、状态文件、结果文件、通知事件的格式约定
docs/              使用指南与设计决定
test/              安装器、体检、skill 的测试
evals/             评估：样例仓库、用例、对话剧本
legacy/            不再维护的 Hub 工作流版本
```
