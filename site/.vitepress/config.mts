import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const version: string = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;

/** ADR pages for the sidebar, titled by their first heading ("0018 可选：…"). */
function adrItems() {
  const dir = path.join(REPO, "docs", "adr");
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-.*\.md$/.test(f))
    .sort()
    .map((f) => {
      const title = /^#\s+(.+)$/m.exec(fs.readFileSync(path.join(dir, f), "utf8"))?.[1] ?? f;
      return { text: title, link: `/reference/adr/${f.replace(/\.md$/, "")}` };
    });
}

const base = process.env.BASE_URL ?? "/";

/** Numbers for the home page, read from the repository so they stay true. */
function homeNumbers() {
  const versions = [...fs.readFileSync(path.join(REPO, "CHANGELOG.md"), "utf8").matchAll(/^## (\d+\.\d+\.\d+\S*)/gm)].map((m) => m[1]);
  return {
    version,
    beta: version.includes("-"),
    releases: versions.length,
    stable: versions.filter((v) => !v.includes("-")).length,
    adrs: adrItems().length,
  };
}

export default defineConfig({
  lang: "zh-CN",
  title: "req-kit",
  titleTemplate: ":title · req-kit",
  description: "在 Paseo 中用对话对齐需求，由一组 AI agent 在后台完成设计、实现、评审和验证。给测试、产品、项目经理用的需求开发体系。",
  base,
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: `${base.replace(/\/$/, "")}/favicon.svg` }],
    ["meta", { name: "theme-color", content: "#a8e01f" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "req-kit：从一句需求，到可验收的功能" }],
    ["meta", { property: "og:description", content: "在 Paseo 中用对话对齐需求，由一组 AI agent 在后台完成设计、实现、评审和验证。" }],
  ],
  markdown: {
    lineNumbers: false,
  },
  themeConfig: {
    rk: homeNumbers(),
    logo: { light: "/logo-light.svg", dark: "/logo.svg", alt: "req-kit" },
    siteTitle: "req-kit",
    nav: [
      { text: "指南", link: "/guide/", activeMatch: "^/guide/" },
      { text: "参考", link: "/reference/commands", activeMatch: "^/reference/" },
      { text: "更新记录", link: "/changelog" },
      {
        text: `v${version}`,
        items: [
          { text: "更新记录", link: "/changelog" },
          { text: "GitHub Releases", link: "https://github.com/yiyisf/paseo-req-kit/releases" },
          { text: "范围与取舍", link: "/reference/scope" },
        ],
      },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "开始",
          items: [
            { text: "req-kit 是什么", link: "/guide/" },
            { text: "快速开始", link: "/guide/getting-started" },
            { text: "工作原理", link: "/guide/how-it-works" },
          ],
        },
        {
          text: "使用",
          items: [
            { text: "使用者指南", link: "/guide/user" },
            { text: "分阶段执行与提测", link: "/guide/phases" },
          ],
        },
        {
          text: "安装与维护",
          items: [
            { text: "安装与升级", link: "/guide/install" },
            { text: "项目定制与运行规则", link: "/guide/project" },
            { text: "维护者指南", link: "/guide/maintainer" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "参考",
          items: [
            { text: "命令", link: "/reference/commands" },
            { text: "配置项", link: "/reference/config" },
            { text: "范围与取舍", link: "/reference/scope" },
          ],
        },
        {
          text: "文件格式约定",
          collapsed: false,
          items: [
            { text: "总览", link: "/reference/contracts/" },
            { text: "需求说明 spec.md", link: "/reference/contracts/spec" },
            { text: "状态文件 state.json", link: "/reference/contracts/state" },
            { text: "结果文件", link: "/reference/contracts/result-file" },
            { text: "功能目录中的文件", link: "/reference/contracts/feature-files" },
            { text: "验证方法 verify.md", link: "/reference/contracts/verify" },
            { text: "外部通知事件", link: "/reference/contracts/notifier-event" },
            { text: "req api 的 JSON 输出", link: "/reference/contracts/cli-json" },
            { text: "需求索引与使用记录", link: "/reference/contracts/usage-record" },
          ],
        },
        {
          text: "设计决定（ADR）",
          collapsed: true,
          items: [{ text: "总览", link: "/reference/adr/" }, ...adrItems()],
        },
      ],
    },
    socialLinks: [{ icon: "github", link: "https://github.com/yiyisf/paseo-req-kit" }],
    editLink: {
      pattern: "https://github.com/yiyisf/paseo-req-kit/edit/main/site/:path",
      text: "在 GitHub 上编辑此页",
    },
    footer: {
      message: "以 MIT 许可发布。req-kit 是运行在 Paseo 上的社区项目。",
      copyright: "Copyright © 2026 yiyisf",
    },
    search: {
      provider: "local",
      options: {
        translations: {
          button: { buttonText: "搜索文档", buttonAriaLabel: "搜索文档" },
          modal: {
            noResultsText: "没有找到相关结果",
            resetButtonTitle: "清除",
            footer: { selectText: "选择", navigateText: "切换", closeText: "关闭" },
          },
        },
      },
    },
    outline: { level: [2, 3], label: "本页内容" },
    docFooter: { prev: "上一页", next: "下一页" },
    lastUpdated: { text: "最后更新" },
    returnToTopLabel: "回到顶部",
    sidebarMenuLabel: "目录",
    darkModeSwitchLabel: "外观",
    lightModeSwitchTitle: "切换到浅色",
    darkModeSwitchTitle: "切换到深色",
    externalLinkIcon: true,
    notFound: { title: "页面不存在", quote: "这个页面可能已经移动或删除。", linkText: "回到首页" },
  },
});
