# Paseo 插件

插件住在 Paseo 里，是客人：底色、文字、描边跟着 Paseo 的主题走（`theme.colors`），这样在 Paseo 的深色、浅色和手机上都不突兀。req-kit 的样子由下面几样东西带出来，不靠换掉 Paseo 的底色。

## 取色

| 用途 | 取自 |
|---|---|
| 页面底、面板、卡片底 | Paseo `surface0` / `surface1` / `surface2` |
| 正文、次要文字 | Paseo `foreground` / `foregroundMuted` |
| 描边、分隔线 | Paseo `border` |
| 状态（警告、失败、成功） | Paseo `statusWarning` / `statusDanger` / `statusSuccess` |
| **人做决定的主按钮、"等你处理"标记、当前选中** | req-kit `brand-500` + `on-brand`（深浅主题都是青柠底深色字），浅色主题加 `brand-edge` 描边 |
| 青柠色的文字和细线 | req-kit `brand-text`：插件按 Paseo `surface0` 的亮度判断深浅，取对应主题的值 |
| AI 标记、进行中 | req-kit `ai` / `data`（同样按深浅取值） |

Paseo 自己的 `accent` 只留给 Paseo 的导航；插件里的次要按钮用 `surface2` 底 + `border` 描边。

## req-kit 的样子

1. **页头**：18px 标志 + 字标 `req-kit`（连字符青柠），右边是页面名（需求、等你处理、统计）。只在插件首页和需求详情出现。
2. **等宽小标题**：分组标题用 `eyebrow`（`mono` 12px、0.16em 字距、大写英文），颜色 `foregroundMuted`；选中的分组用 `brand-text`。例：`NEEDS YOU`、`IN PROGRESS`、`DONE`。
3. **步骤轨**：需求详情顶部，一行编号圆点串起"对齐 → 方案 → 实现 → 评审 → 验证 → 验收"，当前步高亮（见 `components/StepTrack.md`）。
4. **状态 = 颜色 + 图标 + 词**：列表每行左侧 16px Lucide 图标，右侧状态词徽章。
5. **一页一个青柠按钮**："等你处理"的每一项只有一个主按钮（审查原型并确认方案 / 开始开发 / 代码审查 / 验收清单）。

## 页面

- **需求总览**：三组卡片列表 `NEEDS YOU`（等你处理，最上面）、`IN PROGRESS`、`DONE`；每行：图标、需求标题（`title-sm`）、项目名和功能目录（`code-sm`，`foregroundMuted`）、阶段徽章、最近一次动作的时间。
- **等你处理**：每项一张卡：一句话说要你做什么（`title-md`），一行原因（`body-sm`），右下主按钮；从对话来的问题直接列在卡里。
- **需求详情**：页头 → 步骤轨 → 当前状态卡（进行中显示正在做的步骤和"预计还要多久"）→ 操作区（代码审查、验收清单、原型审查）→ 文件（需求说明、方案、报告）→ 用量。
- **统计**：数字条（StatTile）→ "token 花在哪"条形图 → 人工把关和合并后 → 等待 → 各步骤用时。条形图的条用 req-kit `data`，返工部分用 `status-warning`。

## 限制

- 插件用 React Native 组件渲染，没有 CSS 渐变和模糊：不画极光，不用渐变标题。
- 手机宽度下（`layout.compact`）卡片单列、内边距 12px，主按钮占满一行。
