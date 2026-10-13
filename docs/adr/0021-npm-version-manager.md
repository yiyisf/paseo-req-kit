# 0021 npm 分发：全局包是版本管理器，各版本仍装在 versions/ 下

- 状态：已采纳（在 [0009](0009-versioned-install-layout.md)、[0016](0016-upgrade-from-tags.md) 的基础上增加 npm 来源）

## 背景

git 安装要 clone、npm install、运行安装器三步，Windows 上还要自己把 `~/.req-kit/bin` 加进 PATH。npm 全局安装能解决这两点，但 `npm i -g` 升级时原地覆盖：正在运行的流水线每个步骤都从磁盘读提示词，会混用新旧版本，也失去了"旧版本目录保留、随时回滚"的保证（0009）。

## 决定

- 只发布一个包 `paseo-req-kit`。用 `npm i -g` 安装的那一份是**版本管理器**：`req setup`、`req upgrade`、`req use`、`req versions` 由它处理，其他命令转交给 `~/.req-kit/active.json` 指向的版本。
- 版本仍装在 `~/tools/req-kit/versions/<版本>`，用 `npm install --prefix versions/<版本> paseo-req-kit@<版本>` 安装，程序在其中的 `node_modules/paseo-req-kit`。`req setup` 用 `npm pack` 把管理器自己装进去，不必再从仓库下载一次。
- `req upgrade` 从 npm 读版本列表，用本机 daemon 报告的版本和每个版本声明的 `reqKit.paseo` 范围筛选，只升级到能支持本机 Paseo 的版本。正式版另设 `paseo-<小版本>` dist-tag，供手工安装。
- git 方式安装继续支持，默认来源按安装方式决定，`--from` 可以改。
- 发布由 GitHub Actions 在标签推送时完成，使用 npm 可信发布（OIDC），不保存 npm 口令；Release 附带 `npm pack` 的安装包供离线和内网仓库使用。

## 影响

安装变成两条命令，PATH 由 npm 处理。管理器自身很少需要升级（`npm i -g paseo-req-kit` 即可），版本切换不受影响。读不到 daemon 版本时不能按 Paseo 版本筛选，会提示并在升级后建议体检。
