---
name: req-setup
description: req-kit 项目接入。在项目根目录为 req-kit 生成或更新项目说明、验证方法（实际运行其中的命令）和项目配置，确认后提交。新项目第一次使用 /req 之前、项目的构建或测试方式变了、或用户输入 /req-setup 时使用。
metadata:
  opencode/slash: "true"
---

# req-kit 项目接入（{{REQ_KIT_VERSION}}）

为当前项目生成三份文件，让流水线的每个步骤不必每次重新摸索这个项目：

| 文件 | 内容 | 谁读 |
| --- | --- | --- |
| `.requirement-pipeline/project-notes.md` | 本项目的约定：包管理工具、目录结构、不能改的地方、提交信息格式、已知的坑 | 流水线每个步骤、`/req` 访谈前 |
| `.requirement-pipeline/verify.md` | 验证方法：安装依赖、启动服务、运行测试、准备测试数据，命令都实际跑过 | 实现、修复、服务启动、验证、复验步骤 |
| `.requirement-pipeline.json` | 项目配置（可选）：本项目用的 agent、默认档位、轮数、超时 | 流水线 |

格式见 `{{REQ_KIT_ROOT}}/contracts/verify.md`。这个入口通常由开发同事或熟悉项目的测试同事运行。

## 步骤

1. 确认位置
2. 自己读项目
3. 只问读不出来的事
4. 实际运行验证命令
5. 写文件并展示
6. 确认后提交

## 1. 确认位置

在项目的根目录（git 仓库根）运行。用 `git rev-parse --show-toplevel` 确认当前目录就是仓库根；不是的话，告诉用户到仓库根目录的对话中运行。不要 `cd` 到别处。

建议在项目主目录、主分支上运行，这样文件提交后，之后从主分支新建的 worktree 都会带上。当前在某个需求的 worktree 中时，提醒用户：提交只在这个分支上，合并后其他需求才能用到。

已经有这些文件时，这次是更新：读出现有内容，只改过时或缺失的部分，最后以差异形式展示。

## 2. 自己读项目

先读，不要先问：

- `README`、`CONTRIBUTING`、`AGENTS.md`、`CLAUDE.md`、`docs/` 下的开发文档
- 包管理与脚本：`package.json`（scripts、packageManager、engines）、锁文件类型、`Makefile`、`justfile`、`pyproject.toml`、`go.mod`、`pom.xml`、`build.gradle`、`Cargo.toml` 等
- 测试：测试框架和配置、测试目录、端到端测试工具（Playwright、Cypress 等）
- 运行：`docker-compose.yml`、`.env.example`、启动脚本、`paseo.json`
- CI 配置（`.github/workflows/` 等）：它跑的命令通常就是最可靠的验证命令
- 提交历史：`git log --oneline -20`，看提交信息的格式
- 功能目录中已有的 `service-start.md`、`verification.md` 里"建议写入 verify.md 的内容"一节（如有）

## 3. 只问读不出来的事

一次一个问题，给选项和推荐。通常只有这些需要问：

- 有没有不能改的目录或文件（例如生成的代码、第三方代码、迁移历史）
- 测试账号、测试数据从哪里来（只记录位置，不要把真实口令写进文件）
- 外部服务（短信、支付、邮件）在本地怎么替代
- 端到端验证用什么方式：现有工具，还是手工按步骤走
- 这个项目的需求默认走哪个档位，要不要换 agent（不需要就不写项目配置）

## 4. 实际运行验证命令

按读到的做法，依次实际运行：安装依赖、构建或类型检查、代码检查、测试、启动服务并确认就绪、端到端检查（有的话）。每条记录：命令、所在目录、用时、结果（例如"412 个用例全部通过"）。

- 失败的命令不要写成可用。查明原因：是环境问题（缺少服务、缺少配置）就写明准备步骤后重试；是项目本身的问题就写进"已知问题"。
- 启动的服务、容器在结束前关掉。
- 不连接生产环境，不使用生产凭据，不触发真实的外部动作。

## 5. 写文件并展示

- `verify.md`：按 `{{REQ_KIT_ROOT}}/contracts/verify.md` 的结构，第一行之后写"最后核对：<日期>（/req-setup，<全部命令已运行 / 哪些没能运行>）"。只写实际跑通的命令；跑不通的写在"已知问题"。
- `project-notes.md`：一条一行，只写对做需求有影响的约定。例如"包管理用 pnpm，不要用 npm""数据库变更必须写成 migrations/ 下的迁移脚本""不要改动 legacy/ 目录""提交信息用 Conventional Commits 格式"。
- `.requirement-pipeline.json`：只在需要和本机配置不同的设置时才写，例如 `{ "defaultProfile": "quick" }`。不要写 `daemonUrl`、`daemonPasswordEnv`、`teamConfig`，写了也会被忽略。
- `.gitignore`：确认包含 `docs/features/*/.pipeline/`（流水线的运行状态），没有就建议加上。

把三份文件的内容（更新时是差异）展示给用户，并说明运行验证的结果：哪些通过、哪些没能运行以及原因。

## 6. 确认后提交

用户确认后，只提交这几个文件（和 `.gitignore` 的改动），提交信息例如 `chore(req-kit): 项目接入说明与验证方法`。不 push。

最后告诉用户：之后项目的构建、测试或启动方式有变化时，再运行一次 `/req-setup`；也可以直接编辑这些文件。可以运行 `/req-doctor` 确认项目检查全部正常。
