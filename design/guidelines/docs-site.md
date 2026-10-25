# 文档站与首页

文档站现在用 VitePress（`site/`），随安装包带上、`req docs` 在本机打开，内网也能用 Git Pages 托管。首页沿用极光和 Bento，正文页去掉极光，回到安静好读的阅读界面。默认跟随系统深浅色，右上角可切换。

## 主题映射

主题层只做一件事：把本系统的 tokens 映射到 VitePress 的 CSS 变量，组件样式按下面的规范覆盖。不改 VitePress 的结构。

| VitePress 变量 | req-kit token |
|---|---|
| `--vp-c-bg` / `--vp-c-bg-alt` / `--vp-c-bg-soft` | `canvas` / `surface-1` / `surface-2` |
| `--vp-c-text-1` / `-2` / `-3` | `text-primary` / `text-secondary` / `text-muted` |
| `--vp-c-divider` / `--vp-c-border` | `border-subtle` / `border-default` |
| `--vp-c-brand-1` | `brand-text` |
| `--vp-c-brand-2` / `-3` | `brand-400` / `brand-500` |
| `--vp-c-brand-soft` | `brand-tint` |
| `--vp-button-brand-bg` / `-text` | `brand-500` / `on-brand` |
| `--vp-c-tip-*` / `--vp-c-warning-*` / `--vp-c-danger-*` / `--vp-c-note-*` | `status-success` / `status-warning` / `status-failed` / `data` 及对应 tint |
| `--vp-font-family-base` / `-mono` | `font-sans` / `font-mono` |

## 首页（`site/index.md`）

自定义 `layout: home` 的 hero 和 features，结构如下：

1. **Hero**（极光）：版本胶囊（"1.14.0 最新"）→ `display-xl` 标题"一句需求，到**可验收的功能**"（后半句渐变）→ `prose` 导语（最宽 640px）→ 安装命令 Terminal（npm / 镜像两个标签）→ 主按钮"快速开始" + 次按钮"req-kit 是什么"。
2. **步骤轨**：横向一条"对齐 → 方案 → 实现 → 评审 → 验证 → 验收"，每个圆点下一行说明谁来做（你 / AI），人做决定的两步（确认方案、验收）用青柠绿圆点。
3. **Bento 能力区**：8 + 4（"对话对齐需求" 主卡带一段真实对话截图 + "审查原型"）、4 + 4 + 4（质量门、代码审查、验收清单）、12（拦截危险命令与密钥扫描，配一段真实通知文字）。
4. **数字条**：4 张 StatTile，只放可核实的数字（发布版本数、自动化测试数、设计决定记录数、支持的需求类型数）。
5. **更新**：最新版本一句话 + 链接到更新记录。

## 正文页

- 侧边栏分组标题 `eyebrow`（`text-muted`），条目 `body-sm`；当前页 `brand-tint` 底 + `brand-text` 字 + 左侧 2px `brand-500` 竖线；新内容后加 `caption` 胶囊"新"。
- H1 32px（`title-lg` 放大），H2 `title-lg`，H3 `title-md`，正文 `prose`，最宽 760px。
- **Callout**：提示 `success-tint` + `Lightbulb`，注意 `warning-tint` + `TriangleAlert`，危险 `failed-tint` + `OctagonAlert`，说明 `data-tint` + `Info`。不用彩色左边框。
- **代码块**：`surface-2` + `border-default` + `radius-lg`；顶部文件名栏 + 复制按钮；关键字 `brand-text`，字符串 `status-success`，属性名 `data`，注释 `text-muted`。
- **命令**：`req` 命令一律放 Terminal 组件（`$` 提示符 + 复制按钮）。
- 每页第一句写"读完能做到什么"；先给能复制运行的最小例子，再解释选项。

## 不要

- 正文页不放极光、不放大标题渐变。
- 不展示没发布的能力；规划中的写"规划中"。
