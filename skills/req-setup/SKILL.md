---
name: req-setup
description: req-kit 项目接入。在项目根目录为 req-kit 生成或更新项目说明、验证方法（实际运行其中的命令）、Paseo 的 paseo.json 和项目配置，确认后提交。新项目第一次使用 /req 之前、项目的构建或测试方式变了、或用户输入 /req-setup 时使用。
metadata:
  opencode/slash: "true"
---

# req-kit 项目接入（{{REQ_KIT_VERSION}}）

为当前项目生成以下文件，让流水线的每个步骤不必每次重新摸索这个项目：

| 文件 | 内容 | 谁读 |
| --- | --- | --- |
| `.requirement-pipeline/project-notes.md` | 本项目的约定：包管理工具、目录结构、不能改的地方、提交信息格式、已知的坑 | 流水线每个步骤、`/req` 访谈前 |
| `GLOSSARY.md` | 术语表（推荐）：业务词、含义、代码中的名字。访谈和方案设计会继续补充 | `/req` 访谈、流水线每个步骤 |
| `.requirement-pipeline/verify.md` | 验证方法：安装依赖、启动服务、运行测试、准备测试数据，命令都实际跑过 | 实现、修复、服务启动、验证、复验步骤 |
| `paseo.json` | Paseo 的工作区设置（推荐）：新建 worktree 时自动安装依赖、复制本地配置；把常驻服务定义为由 Paseo 管理的服务，每个 worktree 分到独立的端口 | Paseo；流水线在服务启动和验证前通过 Paseo 启动这些服务 |
| `.requirement-pipeline.json` | 项目配置：**质量门的检查命令**（`checks`，推荐）、关联仓库（`relatedRepos`，有就写）；本项目用的 agent、默认档位、轮数、超时（需要时） | 流水线 |

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
- 这个项目的需求默认走哪个档位，要不要换 agent（不需要就不写这些项）
- 有没有相关的其他仓库（例如这是前端，接口在另一个后端仓库）：在这台机器上的位置、它提供什么。登记后流水线的步骤可以只读参考它，不会改动它
- 多模块的仓库（例如 `web/` 和 `server/` 各有自己的测试）：确认各模块的检查命令，第 5 步按模块写进 `checks`
- 项目已经有 `paseo.json` 时，要不要由你补充；没有时，要不要生成（推荐生成，见第 5 步）

## 4. 实际运行验证命令

按读到的做法，依次实际运行：安装依赖、构建或类型检查、代码检查、测试、启动服务并确认就绪、端到端检查（有的话）。每条记录：命令、所在目录、用时、结果（例如"412 个用例全部通过"）。

- 失败的命令不要写成可用。查明原因：是环境问题（缺少服务、缺少配置）就写明准备步骤后重试；是项目本身的问题就写进"已知问题"。
- 启动的服务、容器在结束前关掉。
- 生成了 `paseo.json` 的服务定义时，设置环境变量 `PASEO_PORT=<一个空闲端口>` 后手工跑一遍它的启动命令（`node scripts/paseo/with-port.mjs …`），确认服务确实监听这个端口，再关掉。准备命令也照样跑一遍（`copy-local-files.mjs` 需要设置 `PASEO_SOURCE_CHECKOUT_PATH`）。
- 不连接生产环境，不使用生产凭据，不触发真实的外部动作。

## 5. 写文件并展示

- `verify.md`：按 `{{REQ_KIT_ROOT}}/contracts/verify.md` 的结构，第一行之后写"最后核对：<日期>（/req-setup，<全部命令已运行 / 哪些没能运行>）"。只写实际跑通的命令；跑不通的写在"已知问题"。
- `project-notes.md`：一条一行，只写对做需求有影响的约定。例如"包管理用 pnpm，不要用 npm""数据库变更必须写成 migrations/ 下的迁移脚本""不要改动 legacy/ 目录""提交信息用 Conventional Commits 格式"。再加一节**范例文件**：各类代码（接口、页面、数据访问、测试、迁移脚本等）在项目里写得最好的一个文件，例如"接口：`src/api/orders.ts`；单元测试：`test/api/orders.test.ts`"。方案设计会让每个任务照着范例写，代码更像项目原有的样子。只列你读过、确认写得规范的文件。
- `GLOSSARY.md`（仓库根目录）：项目还没有术语表时，从代码、文档和界面文字中整理主要的业务词，每条写含义和代码中的名字（类名、字段、接口路径或表名），格式见 `{{REQ_KIT_ROOT}}/skills/requirement-interview/SKILL.md` 的"术语"一节。已有的只补充"代码中的名字"等缺失的部分，不改别人写的含义。拿不准含义的不要写，留给访谈时问。
- `paseo.json`（Paseo 读取，格式见 Paseo 文档的 Git worktrees 一节）。它会提交、整个团队共用，而团队成员的电脑可能是 macOS、Linux 或 Windows，Paseo 在各系统上用不同的 shell 执行其中的命令（macOS/Linux：bash 和 sh；Windows：准备命令用 PowerShell、脚本用 cmd.exe）。所以**命令一律写成各系统都一样的形式**：只调用程序本身（`npm`、`pnpm`、`node`、`python` 等），不用 shell 的语法——不写 `$变量`、`%变量%`、`$env:变量`，不用 `&&`、`||`、`cp`、`[ -f … ]`、`Copy-Item`。需要读环境变量或判断文件的逻辑交给下面两个脚本：
  - 把 `{{REQ_KIT_ROOT}}/skills/req-setup/templates/paseo/` 中的 `with-port.mjs` 和 `copy-local-files.mjs` 复制到项目的 `scripts/paseo/`（已有就比较，内容相同不动），和 `paseo.json` 一起提交。它们只依赖 Node.js（req-kit 本来就需要）。
  - `worktree.setup`：写成数组，一行一条命令。通常是安装依赖（用锁文件对应的命令，例如 `npm ci`、`pnpm install --frozen-lockfile`），以及复制不提交的本地配置：`node scripts/paseo/copy-local-files.mjs .env config/local.json`（来源目录里没有的文件会跳过，不会报错）。
  - `scripts`：常用的命令写成脚本（如 `test`、`lint`）；常驻服务写成 `"type": "service"`，必须监听 Paseo 分配的端口，不要写死。写法：`node scripts/paseo/with-port.mjs npm run dev -- --port {PORT}`（`{PORT}` 换成 Paseo 分配的端口，同时设置环境变量 `PORT`）；程序本来就读取 `PORT` 环境变量的，`node scripts/paseo/with-port.mjs npm start` 即可。服务之间互相调用的地址，让程序读取环境变量 `PASEO_SERVICE_<名称>_URL`。
  - 例子：

    ```json
    {
      "worktree": { "setup": ["npm ci", "node scripts/paseo/copy-local-files.mjs .env"] },
      "scripts": {
        "test": { "command": "npm test" },
        "web": { "type": "service", "command": "node scripts/paseo/with-port.mjs npm run dev -- --port {PORT}" }
      }
    }
    ```
  - 团队确定只用一种系统、并且用户明确要求时，才可以用那种系统的 shell 写法；`/req-doctor` 会提示它在其他系统上不能用。
  - 已有 `paseo.json` 时只补充缺少的部分，不改别人写的内容。
  - 在 `verify.md` 的启动服务一节注明：服务已定义在 `paseo.json`，由流水线通过 Paseo 启动；同时保留手工启动的命令，供没有 Paseo 时使用。
- `.requirement-pipeline.json`：
  - `checks`（推荐）：质量门的检查。流水线会在写代码和修复的步骤之后**自己运行**它们，只拦"改动之前通过、现在失败"的检查，并把输出发回给那一步的 agent 修复，不依赖 agent 自己说"测试通过了"。把第 4 步实际跑通、几分钟内能跑完的检查写进去：格式、lint、类型检查、单元测试、构建（端到端测试和需要启动服务的检查不要写，它们由功能验证负责）。命令同样写成各系统通用的形式。多模块的仓库按模块分开写，用 `cwd` 指定模块目录（这项检查只在该模块有改动时运行；需要更精确时用 `paths` 列出它关心的目录）：

    ```json
    {
      "checks": [
        { "name": "lint", "command": "npm run lint" },
        { "name": "web 测试", "command": "npm test", "cwd": "web" },
        { "name": "server 测试", "command": "npm test", "cwd": "server", "timeoutMinutes": 15 }
      ]
    }
    ```
  - `relatedRepos`（有关联仓库时）：`[{ "name": "后端", "path": "../backend", "role": "提供登录和订单接口" }]`。`path` 写相对项目目录的路径（团队约定把相关仓库放在同一个上级目录最方便），也可以写 `~/` 开头的路径。平时流水线的步骤只读不改；需求说明写了"联合开发"时，流水线会为这个需求在它那里新建工作区，一起开发。关联仓库最好也运行过 `/req-setup`，它自己的检查命令、验证方法和项目说明会用在它的步骤里。
  - 其他设置只在需要和本机配置不同时才写，例如 `"defaultProfile": "quick"`。不要写 `daemonUrl`、`daemonPasswordEnv`、`teamConfig`，写了也会被忽略。
- `.gitignore`：确认包含 `docs/features/*/.pipeline/`（流水线的运行状态），没有就建议加上。

把这些文件的内容（更新时是差异）展示给用户，并说明运行验证的结果：哪些通过、哪些没能运行以及原因。

## 6. 确认后提交

用户确认后，只提交这几个文件（以及 `GLOSSARY.md`、`scripts/paseo/` 和 `.gitignore` 的改动）。`paseo.json` 必须提交：Paseo 新建 worktree 时读取的是基准分支上已提交的版本，提交信息例如 `chore(req-kit): 项目接入说明与验证方法`。不 push。

最后告诉用户：之后项目的构建、测试或启动方式有变化时，再运行一次 `/req-setup`；也可以直接编辑这些文件。可以运行 `/req-doctor` 确认项目检查全部正常。
