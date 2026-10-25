# req-kit 设计来源

这个目录是 req-kit 外观和文案的唯一来源：审查原型、验收清单、代码审查三个网页，Paseo 插件，文档站和首页，汇报幻灯片、海报和社媒图都按它来。它和 CMASTER（`yiyisf/reactflow-ui` 的 `design/`）同属 **Bento Launchpad** 家族：中性色、数据色、AI 色、状态色、字体、间距、圆角、阴影取同样的值，只有主色不同（req-kit 是青柠绿）。

它和"req-kit"设计系统 Artifact 互为镜像；两边不一致时，以这里为准，改完再同步过去。

| 路径 | 内容 | 谁读 |
|---|---|---|
| `tokens.json` | 全部 token（两种主题的颜色、字体、间距、圆角、阴影、层级、活动主题色），每个都写了用途 | `scripts/tokens-build.mjs` → `reference/tokens.css` |
| `guidelines/brand.md` | 品牌手册：气质、三种光的含义、标志性元素、原则、文案与术语、色彩、字体、图标、标志、无障碍 | 所有人，先读这个 |
| `guidelines/review-pages.md` | 审查类网页的骨架（顶栏、侧栏、决定栏）和三页各自的内容 | 改 `engine/src/review-assets/` 时 |
| `guidelines/plugin.md` | Paseo 插件：哪些颜色跟 Paseo 走、req-kit 的样子靠什么带出来 | 改 `paseo-plugin/` 时 |
| `guidelines/docs-site.md` | 文档站：VitePress 变量映射、首页结构、正文组件 | 改 `site/` 时 |
| `guidelines/marketing.md` | 汇报幻灯片、海报、社媒图、活动主题色、放行轨图形 | 做材料时 |
| `components/*.md` | 每个组件一页：消费方提供什么、状态、规则 | 写或审组件时 |
| `reference/tokens.css` | 生成的 `--rk-*` 变量（深色默认，浅色跟随系统或 `data-theme="light"`） | 页面直接引用 |
| `reference/components.css` | 每个组件的参考实现（`rk-*` 类） | 写页面和组件 |
| `examples/*.html` | 效果图兼示范页，浏览器直接打开；每个文件开头写了它示范哪些规则 | 照着结构做，不照抄内容 |
| `assets/*.svg` | 标志：深色背景、浅色背景、应用图标 | 所有出现标志的地方 |

## token 命名

`tokens.json` 里叫 `brand-500` 的，CSS 里是 `--rk-brand-500`。文字样式是简写变量：`font: var(--rk-type-title-sm)`，字距在 `--rk-tracking-<样式>`。

## 修改设计

1. 改 `tokens.json` 或规范，每个 token 都要有用途说明。
2. 运行 `node scripts/tokens-build.mjs` 生成 `reference/tokens.css`；`--check` 检查是否过期。
3. 新颜色组合自己核对对比度：文字 4.5:1，图标和控件边框 3:1，深浅两种主题都要满足。
4. 打开 `examples/` 里受影响的页面，深色、浅色、400px 宽度各看一遍。
5. 评审里发现的问题变成这里的一条规则，免得再犯。

## 当前状态

- 1.15.0 起，审查网页、Paseo 插件、文档站和每个正式版的海报幻灯片都按这里的规范实现（下面是各部分从哪个 beta 开始）。

- 1.15.0-beta.1 起，三个审查网页（`engine/src/review-assets/`）按这里的规范实现。它们随 npm 包发布，包里不带 `design/`，所以用的是 `scripts/tokens-build.mjs` 复制过去的 `rk-tokens.css`、`rk.css`、`rk-icons.js`；改了这里的 `tokens.json`、`reference/components.css` 或 `examples/icons.js`，要运行一次这个脚本，`engine/test/design.test.ts` 会检查。
- 1.15.0-beta.2 起，Paseo 插件（`paseo-plugin/client/`）按 `guidelines/plugin.md` 实现，颜色来自 Paseo 主题和生成的 `paseo-plugin/shared/rk-colors.ts`。
- 1.15.0-beta.3 起，文档站（`site/`）按 `guidelines/docs-site.md` 实现：变量映射在 `site/.vitepress/theme/custom.css`，首页是 `components/RkHome.vue`；`rk-tokens.css`、`rk.css`、`rk-icons.ts` 和 `site/public/` 里的标志由 `scripts/tokens-build.mjs` 生成。
- 正文页的 Terminal 组件（`req` 命令带提示符和复制按钮）还没有做，命令仍是普通代码块。
