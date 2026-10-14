# .requirement-pipeline/verify.md

项目的验证方法：怎么安装依赖、启动服务、运行测试、准备测试数据。由 `/req-setup` 生成，其中的命令要实际运行过。流水线把它追加到实现、评审修复、服务启动、功能验证、缺陷修复、复验这几个步骤的提示词中（"本项目的验证方法"一节）。

格式自由，建议按下面的结构写，每节给出可以直接复制执行的命令：

```markdown
# 验证方法

最后核对：2026-10-13（/req-setup，全部命令已运行）

## 环境准备
- Node.js 22，pnpm 9
- 安装依赖：`pnpm install`
- 依赖的本地服务：PostgreSQL（`docker compose up -d db`），Redis 不需要

## 构建与静态检查
- 类型检查：`pnpm typecheck`
- 代码检查：`pnpm lint`

## 单元与集成测试
- 全部：`pnpm test`（约 2 分钟，基线 412 个用例全部通过）
- 单个文件：`pnpm test path/to/file.test.ts`

## 启动服务
- 命令：`pnpm dev`（在仓库根目录）
- 就绪判断：`GET http://localhost:3000/health` 返回 200，通常 10 秒内
- 停止：结束该进程；端口 3000

## 端到端验证
- 工具：Playwright，`pnpm e2e`；或手工用浏览器访问 http://localhost:3000
- 测试账号：见 docs/test-accounts.md（不要写入真实口令）
- 测试替身：短信、支付走 `MOCK_EXTERNAL=1`

## 已知问题
- `pnpm test` 中 `report.test.ts` 偶发超时，与需求无关
```

其中几分钟内能跑完的检查（格式、lint、类型检查、单元测试、构建）同时写进项目配置 `.requirement-pipeline.json` 的 `checks`（1.8 起）：流水线会在写代码和修复的步骤之后自己运行它们，作为质量门。`verify.md` 写给 agent 看，`checks` 由流水线执行，两处的命令保持一致。

步骤 agent 发现它过时或不准确时，会在 `service-start.md` 或 `verification.md` 的"建议写入 verify.md 的内容"一节给出实际可行的做法；`/req-setup` 再次运行时会参考这些建议更新本文件。
