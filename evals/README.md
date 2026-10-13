# 评估

改动提示词、skill 或引擎时，用这里的评估确认效果没有变差。分三层，越往下越贵、跑得越少。

| 层 | 评估什么 | 怎么跑 | 什么时候跑 |
| --- | --- | --- | --- |
| 引擎测试 | 编排逻辑：顺序、轮数、续跑、锁、分支规则、通知、迁移、评审小组 | `npm test`（模拟 Paseo，几分钟） | 每次提交 |
| 端到端评估 | 从确认的 spec 到报告的实际产出 | `npm run eval`（真实 Paseo 和 agent，每个用例几十分钟到几小时） | 改动步骤提示词或引擎时；发布前 |
| 对话评估 | `/req` 对齐阶段的对话质量 | 按 `conversation/rubric.md` 人工或半自动进行 | 改动入口、手册、方法 skill 或原则时；发布前 |

## 端到端评估

```bash
npm run eval:self-check                       # 用参考实现检查用例本身（秒级，不需要 Paseo）
npm run eval                                  # 全部用例，使用 ~/.req-kit/config.json
npm run eval -- --case todo-cli-due --keep    # 单个用例，并保留生成的仓库以便查看
```

每个用例：把 `fixtures/` 中的样例仓库复制到临时目录，提交到 `main`，在功能分支上放入 `cases/<用例>/spec.md`（已确认），在前台运行流水线；结束后放入 `cases/<用例>/hidden/` 中的隐藏验收测试并运行。流水线全程看不到隐藏测试。

结果写到 `evals/results/<时间>/`（不提交）：`results.json` 和 `summary.md`。指标：

| 指标 | 含义 |
| --- | --- |
| 隐藏验收 | 隐藏测试是否全部通过 |
| 如实 | 报告结论与隐藏验收是否一致。报告说"可以验收"但隐藏验收没过，记为**夸大**，这是最重要的指标，目标为零 |
| 越界改动 | 功能目录和用例允许的目录（默认 `src/`、`bin/`、`lib/`、`test/`）之外的改动 |
| 用时、轮次、结果文件追问、人工介入 | 效率和稳定性 |

需要留档的基线（例如每次发布前的结果），把 `summary.md` 复制到 `evals/baselines/<版本>.md` 并提交。

### 增加用例

在 `cases/<名称>/` 中放：

- `case.json`：`title`、`fixture`（`fixtures/` 下的目录名）、`feature`（功能目录名）、`profile`（`quick` / `standard`）、`hidden.dir` 与 `hidden.command`（在仓库根目录运行的命令）、可选的 `scope`
- `spec.md`：已确认的需求说明，验收标准写得足够具体，隐藏测试能逐条对应
- `hidden/`：隐藏验收测试。只依赖 Node.js，从 `hidden.dir` 引用仓库文件
- `reference/`：参考实现，覆盖到样例仓库上之后，隐藏测试和仓库自带的测试都应全部通过

`npm test` 会检查每个用例的参考实现能通过隐藏验收；参考实现和隐藏测试至少有一个是错的时，测试会失败。

## 对话评估

见 `conversation/rubric.md`：三个剧本（测试工程师的小改动、产品经理的新需求、项目经理的模糊需求），每个剧本有扮演说明、隐藏事实、陷阱和必须覆盖的要点；评分 9 项、满分 18；结果记在 `conversation/scoresheet.md`。
