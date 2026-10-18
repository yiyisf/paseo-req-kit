# 0032 安装、升级和文档只依赖 npm 源

- 状态：已采纳（1.13.0-beta.1）

## 背景

req-kit 要分发给公司内网的使用者。内网有 npm 镜像，但打不开 GitHub 和部署在 Vercel、GitHub Pages 上的文档站点。过去的一键安装依赖三样外网资源：

- 安装脚本 `install.sh` / `install.ps1` 放在文档站点上；
- npm 上没有某个版本时，脚本去 GitHub 的 Release 列表找安装包；
- 文档只在线上站点。

另外，两份脚本各自实现了检查环境、安装 Paseo、启用、配置 agent、插件这些步骤，改一处要改两处，Windows 和其他系统的行为也容易不一致。

## 决定

- **安装逻辑放进包里**：新增 `req install`（`bin/bootstrap.mjs`，Node.js 实现），包含原来脚本的全部步骤。包新增同名命令 `paseo-req-kit`，所以任何能访问 npm 源的机器都可以直接运行 `npx -y paseo-req-kit@latest install`。
- **镜像地址只说一次**：`npx -y --registry=<镜像> … install`（或 `--registry <镜像>`）会把镜像保存为本机的 npm 源，之后的升级和 Paseo 命令行安装都走镜像；`--no-save-registry` 只用这一次。指定了镜像而镜像上没有这个版本时，直接说明可能还没同步，不再尝试 GitHub。
- **安装脚本变薄**：`install.sh` / `install.ps1` 只检查 Node.js 和 npm、选版本（npm 优先，GitHub Release 兜底），然后用 `npm exec` 运行那个版本自带的 `install`。外网用户的用法不变。
- **文档随包发布**：发布流程把文档站点构建进 npm 包（`site-dist/`），`req docs` 在本机起一个只监听 127.0.0.1 的服务并打开浏览器。文档和装的版本一致，不需要外网。
- 内网的共享文档站点（例如内网 Git Pages）是可选的，可以从镜像中的 npm 包取出 `site-dist/` 部署，另行实现。

## 影响

- 1.13 之前的版本没有 `install` 命令：新的安装脚本只能安装 1.13 及以后的版本。要装更早的版本，用那个版本标签下的旧脚本，或 `npm i -g paseo-req-kit@<版本> && req setup`。
- npm 包增加了构建好的文档站点（约几 MB）。
- 内网只支持 npm 方式安装和升级；git 方式仍需访问 GitHub。
