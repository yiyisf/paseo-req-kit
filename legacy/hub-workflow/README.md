# 需求开发工作流（Paseo）

帮助不写代码的业务同事完成一个需求从"谈清楚"到"做完并验证"的全过程。分为两个阶段：

| 阶段 | 形式 | 覆盖的步骤 | 是否需要人参与 |
| --- | --- | --- | --- |
| A. 需求对齐 | Paseo 聊天中的 skill：`/requirement-kickoff` | 1–2 | 需要，多轮对话 |
| B. 开发流水线 | Paseo Hub 工作流：`requirement-dev` | 3–11 | 不需要，无人值守 |

分成两段的原因：Hub 工作流的每个步骤是一次无人值守的 agent 执行，不能在步骤中途与人来回对话；而需求对齐必须是对话。两个阶段通过"功能目录"里的文件衔接。

## 步骤对照

| 你列的步骤 | 实现位置 | 执行者 | 产物 |
| --- | --- | --- | --- |
| 1. 基于 grill-with-docs 用业务语言对齐需求 | `skills/requirement-kickoff/SKILL.md` | 聊天中的 agent | `alignment.md`、`CONTEXT.md`、`docs/adr/` |
| 2. 生成标准需求 spec（落本地文件） | 同上 + `spec-template.md` | 同上 | `spec.md` |
| 3. 方案设计 | `partials/03-design.md` | builder | `design.md` |
| 4. 方案审核 | `partials/04-design-review.md` | reviewer | `design-review.md` |
| （4 的后续）方案修订，审核要求修改时执行 | `partials/04b-design-revise.md` | builder | 更新 `design.md` |
| 5. TDD 代码实现（按适用性） | `partials/05-implement.md` | builder | 代码、`implementation.md` |
| 6. Code review | `partials/06-code-review.md` | reviewer | `code-review.md` |
| 7. Review 问题修复，评审要求修改时执行 | `partials/07-review-fix.md` | builder | 代码、处理记录 |
| 8. 验证服务启动，项目有常驻服务时执行 | `partials/08-service-start.md` | builder | `service-start.md` |
| 9. 功能验证（基础测试 + E2E） | `partials/09-verify.md` | reviewer | `verification.md` |
| 10. 测试缺陷修复，步骤 9 发现缺陷时执行 | `partials/10-defect-fix.md` | builder | 代码、处理记录 |
| （10 的后续）复验，执行过缺陷修复时执行 | `partials/10b-reverify.md` | reviewer | 更新 `verification.md` |
| 11. 报告及总结，始终执行 | `partials/11-report.md` | builder | `report.md` |

所有产物都在 `docs/features/<YYYYMMDD>-<英文短名>/` 下，代码改动在分支 `feature/<同名>` 上，只做本地提交，不 push、不合并。

## 目录结构

```text
skills/requirement-kickoff/
  SKILL.md              阶段 A 的提示词
  spec-template.md      spec 模板
.paseo/
  hub.yml               运行环境和 agent 定义（需要修改）
  workflows/
    requirement-dev.yml 阶段 B 的步骤、条件和超时
    partials/           每个步骤的提示词；00-shared-context.md 为所有步骤共用
```

## 安装

1. 安装依赖的 skill（阶段 A 会加载其中的 `grilling` 和 `domain-modeling`）：
   ```sh
   npx skills add mattpocock/skills
   ```
2. 把 `skills/requirement-kickoff/` 复制到 `~/.agents/skills/`（或项目内的 `.claude/skills/`）。
3. 把 `.paseo/` 复制到项目仓库的根目录。
4. 修改 `.paseo/hub.yml` 中的 `daemon` 和 `cwd`，以及 `requirement-dev.yml` 中的 `from_users`。
5. 校验并部署：
   ```sh
   paseo hub login <你的 Hub 地址>
   paseo hub permissions grant hub.execute
   paseo hub deploy --project <项目名> --dry-run
   paseo hub deploy --project <项目名>
   ```

## 使用

1. 业务同事在 Paseo 中打开项目，输入 `/requirement-kickoff 我想……`，按提问把需求谈清楚并确认 spec。结束时 agent 会给出功能目录的路径。
2. 启动 `requirement-dev`，prompt 填功能目录的路径，例如 `docs/features/20261012-sms-login`。
3. 流水线结束后，阅读功能目录里的 `report.md`。

## 设计说明

**用文件交接，而不是靠对话记忆。** 每个步骤都是全新的 agent，只读取功能目录中的文件。好处是每一步的输入输出都可以查看，评审者和验证者也不会带有实现者的思路。

**审核、评审、验证由另一个 agent 完成。** 做事的和检查的分开；验证步骤只登记缺陷，不动产品代码。

**需求编号贯穿全程。** spec 中的 FR-n、AC-n.m 在方案、测试、评审、报告中被逐条引用，最终报告按验收标准逐条给出结论。

**按需执行由三个结构化输出控制。** 方案审核的 `verdict`、代码评审的 `verdict`、功能验证的 `result` 决定后续步骤是否执行；方案设计的 `has_runnable_service` 决定是否执行第 8 步。是否采用 TDD 由方案设计按任务判断，并在实现时允许按实际情况调整。

**修复只做一轮。** Hub 工作流没有循环。方案修订、评审修复、缺陷修复各执行一轮，仍未解决的问题由报告如实交给人来决定。

**我在你的 11 步之外加了两步**：方案修订（否则审核意见没有人处理）和复验（否则缺陷修复的结果没有人确认）。不需要的话，删除对应的 step 即可。

## 已知限制和需要你确认的地方

1. **多步骤工作流在 Paseo 文档中被称为 legacy project bundle。** 新的默认格式是 `.paseo/triggers/` 下的单步触发器，不支持有序步骤。目前只有这种 bundle 格式能表达多步骤流程，但需要留意它今后是否会被替换。
2. **`manual.run` 的启动方式。** 文档只说明它"从 Hub API 启动"，我没有找到具体的接口或命令。请在 Hub 控制台中确认，或改用文件末尾注释中的 Slack 触发方式。
3. **表达式的两处行为未在文档中明确**，建议先用 `--dry-run` 校验，并各试跑一次：被跳过的步骤其 `outputs` 取值是什么（本文件通过把 `values.build_approved` 放在 `&&` 左侧来避免读取它）；`&&` 是否短路求值。
4. **阶段 A 和阶段 B 必须使用同一台机器上的同一个仓库目录**，否则流水线读不到 spec。
5. **同一个仓库目录一次只跑一个需求。** 各步骤会切换分支，并行运行会互相干扰。需要并行时，为每个需求准备单独的检出目录和 environment。
6. **agent 以免确认模式运行。** 这是无人值守的前提，也意味着它们在那台机器上可以执行命令。请阅读 [Hub security](https://paseo.sh/docs/hub/security)。
7. **`idle_timeout`** 可能会把长时间无输出的测试命令判为空闲。测试套件运行很久的项目，请调大实现和验证步骤的这个值。
8. 提示词尚未在真实项目上运行过。建议先用一个小需求完整走一遍，再根据各步骤产物的质量调整。
