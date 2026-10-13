# 0016 一键升级：从 git 标签下载到 versions/ 再切换

- 状态：已采纳（在 [0009](0009-versioned-install-layout.md) 的目录结构上增加自动化）

## 背景

手工升级要 clone、npm install、运行 install.mjs 三步，非专业开发的使用者容易漏掉 npm install 或在错误的目录运行。

## 决定

- `node install.mjs --upgrade [版本]`（`req upgrade`）：用 `git ls-remote --tags` 读取已发布版本，`git clone --depth 1 --branch <标签>` 到 `versions/<版本>`，`npm install --omit=dev`，再运行新版本的 `install.mjs` 切换。
- 不写版本时取最新版本；当前是正式版时只升级到正式版，当前是预发布版（beta）时也考虑预发布版。
- 下载地址取 `package.json` 的 `repository`，可用环境变量 `REQ_KIT_REPO_URL` 或 `--from` 改为内网镜像。
- 任何一步失败，当前版本不受影响；下载先写到临时目录，完整后才改名为版本目录。
- 安装时在 `~/.req-kit/bin` 写入 `req`（和 Windows 的 `req.cmd`），指向当前启用的版本。是否加入 PATH 由使用者决定，安装程序只给出命令，不修改系统设置。

## 影响

升级只需要 git 和 npm 可用；回滚仍是在旧版本目录运行 `node install.mjs`。体检会提示有新版本（离线时跳过）。
