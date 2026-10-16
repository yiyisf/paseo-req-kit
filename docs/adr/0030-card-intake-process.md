# 0030 接单器：共享机器上定时接卡片、转达回复

- 状态：已采纳（1.11.0-beta.1；建在 [0029](0029-requirements-from-cards.md) 之上）

## 背景

1.10 已经可以从一张卡片开始需求（`req start --from`）、把需求方在卡片中的回复转给需求会话（`req card check`），但这两步都要有人运行。"软件工厂"要求需求方只在卡片上操作：写好卡片、标题加上约定的标识，就有一台共享研发机器接手。

## 决定

- **一个常驻进程，两件事**：`req factory run` 每隔 `factory.pollMinutes`（默认 5 分钟）检查一次：先用对接配置的 `list` 命令列出各空间（本机登记仓库的 `cardSource.projectId`）中的卡片，标题以 `factory.titleTags`（默认 `[AI]`、`【AI】`）开头、本机还没开始过的，按 1.10 的 `req start --from` 开始（按子系统选仓库、建需求会话）；再按 `req card check --all` 转达回复，跳过流水线已完成的需求。同一台机器上一次只做一次检查（`~/.req-kit/factory/poll.lock`）。
- **轮询外部系统，不用回调**：需求管理系统没有我们能用的事件推送；轮询的间隔是几分钟，对需求开发足够，失败了下次再来。卡片状态、条件（例如只查"新建"的用户故事）写在 `list` 的参数里，由团队配置决定。
- **克制地接单**：每次最多开始 `factory.maxNewPerPoll`（默认 3）个需求，其余下次再接；流水线本身仍受 `maxConcurrentPipelines` 限制。接不了的卡片（例如子系统没有对应的仓库）记下原因，卡片的标题和子系统不变就一天内不再试，`req factory status` 中可以看到。
- **只读卡片、不改卡片状态来"占位"**：本机的登记（`~/.req-kit/cards/`）就是去重的依据。卡片状态仍只由流水线事件改（开发中、待测试）。将来多台机器同时接单时再引入占位（例如改状态或经内网 Hub 派工），见 [0029](0029-requirements-from-cards.md)。
- **运行方式交给系统**：`req factory start` / `stop` 在后台运行，适合先试；长期运行用系统服务（`req factory service` 给出 systemd 用户服务或 Windows 计划任务的写法），机器重启后自动恢复。接单器通过 Paseo daemon 创建需求会话，daemon 需要同时运行。
- **配置只在本机或团队配置中**：`factory` 和 `integrations` 一样会让机器做事，写在项目配置中会被忽略。

## 影响

- 对接配置新增 `list`（参数可用 `{projectId}`、`{page}`、`{pageSize}`、`{titleTag}`；`fields` 写每张卡片中 id、title 等的位置；`items` 写输出中列表的位置，不写时依次找 data.list、data.records、data.items、data.rows、data）。
- 新增配置 `factory`（`pollMinutes`、`titleTags`、`maxNewPerPoll`）、命令 `req factory once | run | start | stop | status | service`、本机目录 `~/.req-kit/factory/`（日志、状态、没能接的卡片）。
- `req start --from` 中途失败（例如 Paseo 没在运行，会话没建成）时，再次运行会补建会话，而不是当作已经开始过。
