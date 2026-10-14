<p align="center">
  <img src="site/public/logo.svg" width="88" height="88" alt="req-kit">
</p>

<h1 align="center">req-kit</h1>

<p align="center">
  <strong>从一句需求，到可验收的功能。</strong><br>
  在 <a href="https://paseo.sh">Paseo</a> 中用对话把需求谈清楚，由一组 AI agent 在后台完成方案设计、代码实现、评审和验证。
</p>

<p align="center">
  <a href="https://github.com/yiyisf/paseo-req-kit/actions/workflows/ci.yml"><img src="https://github.com/yiyisf/paseo-req-kit/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/yiyisf/paseo-req-kit/releases"><img src="https://img.shields.io/github/v/release/yiyisf/paseo-req-kit?include_prereleases&label=release" alt="Release"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-339933" alt="Node.js 22+">
  <img src="https://img.shields.io/badge/Paseo-0.11-3f6fd8" alt="Paseo 0.11">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
</p>

<p align="center">
  <a href="https://paseo-req-kit.vercel.app/">文档站点 (Vercel)</a> ·
  <a href="https://yiyisf.github.io/paseo-req-kit/">GitHub Pages 镜像</a> ·
  <a href="https://paseo-req-kit.vercel.app/guide/getting-started">快速开始</a> ·
  <a href="docs/guide/使用者指南.md">使用者指南</a> ·
  <a href="CHANGELOG.md">更新记录</a>
</p>

---

req-kit 是运行在 Paseo 上的**需求开发体系**，面向非专职开发、但有一定技术背景的同事——测试、产品经理、项目经理。你在对话里讲清楚想要什么、确认一份需求说明；之后的工作由不同角色的 agent 完成，进展和结论发回同一个对话，最后你按验收标准逐条验收。全程只做本地提交，合并和上线由人决定。

```text
你  ▸ /req 登录页增加短信验证码登录
AI  ▸ 我理解的是……对吗？验证码有效期是 5 分钟还是 10 分钟？（推荐 5 分钟：……）
    … 一次一个问题，写成 spec.md，另一个模型独立审阅，你确认
AI  ▸ 已在后台开始开发。每个步骤都在这个对话的子 agent 列表里。
    ◦ 技术方案已经确定（审核 1 轮），开始写代码。
    ◦ 代码已经写完并通过检查，开始按验收标准逐条验证。
AI  ▸ 结论：已完成，可以验收。6 条验收标准全部通过……完整报告：report.md
```

## 特性

- **对话对齐需求**：一次一个问题，给出选项和推荐；确认前由另一个模型独立审阅需求说明，减少返工。
- **后台 agent 流水线**：方案设计 → 方案审核 ⇄ 修订 → 代码实现（适合时 TDD）→ 代码评审 ⇄ 修复 → 提测说明 → 服务启动 → 功能验证 → 缺陷修复 ⇄ 复验 → 完成报告。
- **做事的和检查的分开**：builder 与 reviewer 可用不同模型；可选的评审小组并行评审、方案提案并行比较。
- **如实报告**：每一步的结论只看结果文件和证据；没验证的写"未验证"，遗留问题写进报告。
- **分阶段提测**：研发完成写好提测说明，可以停下来交给测试同事，在已部署的测试环境中验证；缺陷可退回研发。
- **用好 Paseo**：复用 agent profile、`paseo.json` 服务和 worktree、定时任务、内置浏览器；几个需求并行互不干扰。
- **可恢复**：中断后从断点继续；需求变了只处理变化的部分；临时错误自动重试、自动继续。
- **安全边界清楚**：不合并、不推送、不上线；不连接生产环境，不使用生产凭据。

## 快速开始

在运行 Paseo daemon 的机器上（需要 Node.js 22+）：

```bash
# macOS、Linux、Windows 的 Git Bash 或 WSL
curl -fsSL https://raw.githubusercontent.com/yiyisf/paseo-req-kit/main/install.sh | sh
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/yiyisf/paseo-req-kit/main/install.ps1 | iex
```

安装脚本会检查环境、安装 `paseo-req-kit`、为 Claude Code / Codex / OpenCode / Pi 安装 `/req` 等 skill，并引导你为 builder 和 reviewer 选择 agent。再次运行即升级。然后：

1. `req doctor` —— 检查 daemon、agent 模式和额度；
2. 在项目的 Paseo 对话中运行 `/req-setup` —— 接入项目（每个项目一次）；
3. 在 Paseo 对话中输入 `/req 我想……` —— 开始第一个需求。

其他安装方式（npm、离线安装包、git）、各 agent 的配置写法和升级回滚，见 [安装与升级](docs/guide/安装与升级.md)。

## 工作原理

```text
Paseo 对话（/req）                              流水线引擎（后台进程）
  访谈 → spec.md → 独立审阅 → 确认
  启动 ──────────────────────────────────────►  研发：方案设计 → 审核 ⇄ 修订 → 实现
                                                     → 代码评审 ⇄ 修复 → 提测说明
                                                ┄┄ 闸口：连续 / 分阶段 / 只做研发 ┄┄
                                                验证：服务启动 → 功能验证 → 缺陷修复 ⇄ 复验
                                                → 完成报告
  ◄── 进展 · 需要决定的问题 · 等待批准 · 结论 ──
```

- 每个步骤是一个新的 Paseo agent，作为子 agent 挂在发起的对话下；步骤之间只通过功能目录 `docs/features/<日期>-<名称>/` 中的文件交接。
- 每一步写一个 JSON 结果文件，流水线据此决定下一步，不解析 agent 的回复文字。
- 运行状态在 `.pipeline/state.json`，可以随时查看进度、暂停、继续。

详见 [工作原理](https://paseo-req-kit.vercel.app/guide/how-it-works)。

## 文档

| 读者 | 文档 |
| --- | --- |
| 使用者 | [使用者指南](docs/guide/使用者指南.md) |
| 安装和维护的人 | [安装与升级](docs/guide/安装与升级.md) |
| 项目维护者 | [项目定制与运行规则](docs/guide/项目定制与运行规则.md) |
| 体系维护者 | [维护者指南](docs/guide/维护者指南.md) · [设计决定](docs/adr/) · [文件约定](contracts/) · [范围](SCOPE.md) · [评估](evals/README.md) |

这些文档也发布在 [文档站点 (Vercel)](https://paseo-req-kit.vercel.app/)（附 [GitHub Pages 镜像](https://yiyisf.github.io/paseo-req-kit/)），附有命令和配置参考。

## 项目结构

| 目录 | 内容 |
| --- | --- |
| `skills/` | 安装到各 agent 的 skill：入口（`/req`、`/req-setup`、`/req-doctor`、`/req-retro`）、方法（访谈、需求说明、验收标准、结果说明）、原则 |
| `engine/` | 流水线引擎：`src/` 程序、`prompts/` 步骤提示词、`test/` 场景测试（模拟 Paseo 运行时） |
| `bin/` | `req`、`start-pipeline`、`req-doctor` 命令 |
| `install.mjs`、`install.sh`、`install.ps1` | 安装、升级、回滚、卸载；一键安装脚本 |
| `contracts/` | spec、状态文件、结果文件、通知事件等的格式约定 |
| `docs/` | 使用指南与设计决定（ADR） |
| `evals/` | 端到端评估：样例仓库、隐藏验收测试、对话剧本 |
| `site/` | 文档站点（VitePress） |
| `notifiers/` | 外部通知（企业 IM 等）的模板 |

入口之间不互相调用；引擎不调用 skill，只读取提示词和原则索引。

## 开发

```bash
npm install
npm test                  # 引擎场景测试（模拟 Paseo）、安装器、一键安装脚本、体检、skill 校验
npm run typecheck
npm run eval:self-check   # 评估用例的参考实现能否通过隐藏验收（不需要 Paseo）
npm run eval              # 用真实的 Paseo 和 agent 跑端到端评估

cd site && npm install && npm run dev   # 本地预览文档站点
```

引擎的编排逻辑用模拟的 Paseo 运行时（`engine/test/fake-runtime.ts`）运行真实代码来测试；真实 daemon 和 agent 的行为、提示词的产出质量通过冒烟测试和评估确认。发布流程见 [维护者指南](docs/guide/维护者指南.md)。

## 参与贡献

- 先读 [范围](SCOPE.md)：新的提议需要服务于"把一个需求从对齐做到可验收"，并有至少两个真实场景。
- 修改设计决定时新增一条 [ADR](docs/adr/)；修改文件格式时同时更新 [contracts/](contracts/)、代码、测试和 CHANGELOG 的"升级须知"。
- 提交前运行 `npm test` 和 `npm run typecheck`。

## 许可

[MIT](LICENSE)
