---
name: req-doctor
description: req-kit 体检。检查 req-kit 的安装、本机配置、Paseo daemon 与 agent、当前项目和进行中的流水线，给出 ✓ / ⚠ / ✗ 清单和修复方法。在 /req 报错、升级之后、更换 agent 或 Paseo 版本之后，或用户输入 /req-doctor 时使用。
metadata:
  opencode/slash: "true"
---

# req-kit 体检（{{REQ_KIT_VERSION}}）

体检只读取信息，不修改任何文件。

## 执行

在当前工作目录执行（bash、PowerShell、cmd 写法相同）：

```
node "{{REQ_KIT_ROOT}}/bin/req-doctor.mjs"
```

它会检查当前工作目录所在的项目。只想检查安装和配置、不检查项目时，加 `--no-project`；不想连接 daemon 时，加 `--offline`。

## 转告结果

1. 先说总体结论：全部正常，或者有几项需要处理。
2. 逐项说明 ✗（必须处理）和 ⚠（建议处理）：是什么问题、会造成什么影响、怎么修。输出里每项都附了修复方法，照着讲清楚即可；命令原样给出。
3. 涉及安装目录、本机配置（`~/.req-kit/config.json`）或 Paseo 设置的修改，由用户自己（或开发同事）完成。你不要直接改这些文件，除非用户明确要求。
4. 修好后建议再运行一次 `/req-doctor` 确认。

## 常见问题

- **skill 版本与安装目录不一致**：在要使用的版本目录中运行 `node install.mjs`。
- **配置中的 provider 还是示例值，或者在 daemon 中不存在**：在终端运行配置向导 `req configure`（或在安装目录运行 `node install.mjs --configure`），按提示选择即可。向导需要在终端里交互，请用户自己运行，你不要代为运行。
- **有新版本**（输出中的 ↑ 行）：不是问题，告诉用户可以在终端运行 `req upgrade` 升级；正在运行的流水线不受影响。
- **连不上 daemon**：确认 Paseo 桌面端或 daemon 在运行；设置了密码时，确认环境变量（默认 `PASEO_DAEMON_PASSWORD`）已设置。
- **发现卡住的流水线**（状态为运行中但进程已不在）：用 `/req` 说"继续开发"即可从中断处继续。
- **状态文件需要迁移**：下次继续时会自动迁移并保留备份，无需手动处理。
