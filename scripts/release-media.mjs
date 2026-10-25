#!/usr/bin/env node
// A poster, a chat card and a slide deck for a stable release, made from its CHANGELOG.md entry
// (design/guidelines/marketing.md; mockups in design/examples/poster.html and slides.html).
//
//   node scripts/release-media.mjs [version] [--out dir] [--tests N] [--date YYYY-MM-DD] [--render] [--force]
//
// Writes poster.html, card.html and slides.html (self-contained: styles, icons and the logo are
// inlined, no web fonts). With --render it also writes poster.png (1080×1920), card.png
// (1200×630) and slides.pdf (1920×1080 pages) using Playwright (resolved from PLAYWRIGHT_DIR,
// or the "playwright" package). The release workflow attaches them to the GitHub Release.
//
// Optional design/releases/<version>.json sets the headline: { "title": "从对齐到验收\n都在*插件里*",
// "lead": "…", "card": "…" } — "\n" breaks a line (at most 3 lines of 8 characters on the poster),
// *…* is the keyword in the brand gradient. Without it the headline is the version number.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

// ---------- arguments ----------
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? false : (args.splice(i, 1), true);
};
const outArg = opt("--out");
const testsArg = opt("--tests");
const dateArg = opt("--date");
const render = flag("--render");
const force = flag("--force");
const version = args[0] ?? JSON.parse(read("package.json")).version;
if (version.includes("-") && !force) {
  console.error(`${version} is a beta; posters and slides are made for stable releases (use --force to try one).`);
  process.exit(2);
}
const out = path.resolve(outArg ?? path.join("release-media", version));
const date = dateArg ?? new Date().toISOString().slice(0, 10);

// ---------- content from CHANGELOG.md ----------
const changelog = read("CHANGELOG.md");
const allVersions = [...changelog.matchAll(/^## (\d+\.\d+\.\d+\S*)\s*$/gm)].map((m) => m[1]);
const start = changelog.indexOf(`## ${version}\n`);
if (start < 0) {
  console.error(`CHANGELOG.md has no "## ${version}" entry.`);
  process.exit(1);
}
const body = (() => {
  const rest = changelog.slice(start + `## ${version}\n`.length);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
})();

/** Plain text from one line of Markdown (links keep their text, code keeps its text). */
const plain = (s) =>
  s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

const section = (title) => {
  const m = new RegExp(`^### ${title}\\s*$`, "m").exec(body);
  if (!m) return "";
  const rest = body.slice(m.index + m[0].length);
  const end = rest.search(/^### /m);
  return end < 0 ? rest : rest.slice(0, end);
};
/** Top-level bullets, each with its continuation and nested lines joined. */
const bullets = (text) => {
  const items = [];
  for (const line of text.split("\n")) {
    if (/^- /.test(line)) items.push(line.slice(2));
    else if (/^\s+\S/.test(line) && items.length) items[items.length - 1] += ` ${line.trim().replace(/^- /, "")}`;
  }
  return items;
};

const summary = (() => {
  const para = body.trim().split(/\n\s*\n/)[0] ?? "";
  if (para.startsWith("#") || para.startsWith("- ")) return "";
  return plain(para)
    .replace(/^稳定版[：:]\s*/, "")
    .replace(/内容包括[^。]*。/g, "")
    .replace(/设计决定见[^。]*。/g, "")
    .trim();
})();

/** Drops a leading "（…）" aside (nested parentheses allowed) and the punctuation after it. */
const dropLeadingAside = (s) => {
  let t = s.trim();
  if (/^[（(]/.test(t)) {
    let depth = 0;
    for (let i = 0; i < t.length; i++) {
      if (/[（(]/.test(t[i])) depth++;
      else if (/[）)]/.test(t[i]) && --depth === 0) {
        t = t.slice(i + 1);
        break;
      }
    }
  }
  return t.replace(/^[\s；;：:，,。]+/, "");
};

const highlights = bullets(section("使用者会看到的变化")).map((b) => {
  const m = /^\*\*(.+?)\*\*\s*(.*)$/.exec(b);
  const title = plain(m ? m[1] : b.split(/[。：:]/)[0]).replace(/[。：:]$/, "");
  const text = dropLeadingAside(plain(m ? m[2] : b.slice(title.length)));
  return { title, text, fix: /^修复/.test(title) };
});
// Fixes go last; new things lead.
highlights.sort((a, b) => Number(a.fix) - Number(b.fix));
const upgrade = bullets(section("升级须知")).map(plain);

const overridesFile = path.join(ROOT, "design", "releases", `${version}.json`);
const overrides = fs.existsSync(overridesFile) ? JSON.parse(fs.readFileSync(overridesFile, "utf8")) : {};

const numbers = {
  releases: allVersions.slice(allVersions.indexOf(version)).length,
  stable: allVersions.slice(allVersions.indexOf(version)).filter((v) => !v.includes("-")).length,
  adrs: fs.readdirSync(path.join(ROOT, "docs", "adr")).filter((f) => /^\d{4}-.*\.md$/.test(f)).length,
  tests: testsArg ? Number(testsArg) : undefined,
};

// ---------- helpers ----------
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Shorten at a sentence or clause boundary near `max` characters. */
const clip = (s, max) => {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("；"), cut.lastIndexOf("，"));
  return at > max * 0.5 ? `${cut.slice(0, at)}。` : `${cut.slice(0, max - 1)}…`;
};
/** "从对齐到验收\n都在*插件里*" → HTML with line breaks and the keyword in `cls`. */
const headline = (s, cls) =>
  esc(s)
    .split("\n")
    .map((line) => line.replace(/\*([^*]+)\*/g, `<em class="${cls}">$1</em>`))
    .join("<br>");

const iconSource = read("design", "examples", "icons.js");
const ICONS = new Function(`return ${/const I = (\{[\s\S]*?\n  \});/.exec(iconSource)[1]}`)();
const LOGO = /const LOGO = '([^']+)';/.exec(iconSource)[1];
const icon = (name, cls = "ic") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ICONS.sparkles}</svg>`;
const logo = `<svg viewBox="0 0 100 100" aria-hidden="true">${LOGO}</svg>`;

/** An icon and a label color for a highlight, from its words. */
const kind = (h) => {
  const t = `${h.title} ${h.text}`;
  const rules = [
    [/修复/, "check", ""],
    [/代码审查|评审/, "git-pull-request", "ai"],
    [/验收|试用/, "clipboard-check", ""],
    [/危险|拦截|打断/, "octagon-alert", "danger"],
    [/密钥/, "lock", "danger"],
    [/统计|记录|token|预算/, "chart-column", "data"],
    [/原型/, "pen-tool", ""],
    [/安装|内网|升级/, "terminal", "data"],
    [/插件|等你处理/, "inbox", ""],
    [/界面|检查|质量/, "shield-check", "data"],
    [/对话|对齐/, "messages-square", ""],
    [/AI|模型|agent/, "sparkles", "ai"],
  ];
  const [, ic, tone] = rules.find(([re]) => re.test(t)) ?? [null, "sparkles", ""];
  return { ic, tone };
};

const title = overrides.title ?? `${version}\n*正式版*`;
const lead = clip(overrides.lead ?? summary ?? "", 84);
const cardTitle = overrides.card ?? title.replace(/\n/g, "");
const css = `${read("design", "reference", "tokens.css")}\n${read("design", "reference", "components.css")}`;

const page = (titleText, style, content, script = "") => `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titleText)}</title>
<!-- Generated by scripts/release-media.mjs from CHANGELOG.md (${esc(version)}). -->
<style>
${css}
:root{--rk-font-sans:Geist,"PingFang SC","Noto Sans SC","Noto Sans CJK SC","Microsoft YaHei",system-ui,sans-serif}
body{background:var(--rk-surface-0);margin:0;padding:24px 16px;display:flex;flex-direction:column;gap:24px;align-items:center}
.frame{flex:none;overflow:hidden;border-radius:12px;box-shadow:var(--rk-shadow-dialog)}
.art{position:relative;overflow:hidden;transform-origin:top left;color:var(--rk-text-primary);font-family:var(--rk-font-sans);background-color:var(--rk-canvas);box-sizing:border-box}
.ic{display:inline-block}
.print body{padding:0;gap:0;background:var(--rk-canvas)}
.print .frame{border-radius:0;box-shadow:none;width:auto!important;height:auto!important}
.print .art{transform:none!important}
@page{margin:0}
${style}
</style>
</head>
<body>
${content}
<script>
// Fit each fixed-size artboard into the window (not when rendering).
const fit = () => {
  if (document.documentElement.classList.contains("print")) return;
  for (const f of document.querySelectorAll(".frame")) {
    const a = f.firstElementChild, w = a.offsetWidth, h = a.offsetHeight;
    const s = Math.min(1, (Math.min(window.innerWidth - 32, w > h ? 960 : 460)) / w);
    f.style.width = w * s + "px"; f.style.height = h * s + "px";
    a.style.transform = "scale(" + s + ")";
  }
};
addEventListener("resize", fit); fit();
${script}
</script>
</body>
</html>
`;

const shared = `
.brandbar{display:flex;align-items:center;gap:18px}
.brandbar svg{width:56px;height:56px;flex:none}
.brandbar .w{font:800 44px/1 var(--rk-font-sans);letter-spacing:-.02em}
.brandbar .w i{font-style:normal;color:var(--rk-campaign-lime)}
.series{height:44px;padding:0 18px;border-radius:999px;border:2px solid var(--rk-campaign-lime);color:var(--rk-campaign-lime);font:500 22px/40px var(--rk-font-mono);box-sizing:border-box}
.eb{font:500 22px/28px var(--rk-font-mono);letter-spacing:.18em;color:var(--rk-campaign-lime);text-transform:uppercase}
.kw{font-style:normal;background:linear-gradient(90deg,var(--rk-campaign-lime-hi),var(--rk-campaign-lime));-webkit-background-clip:text;background-clip:text;color:transparent}
.track{position:absolute;inset:0;pointer-events:none}
`;
const brandbar = (series) => `<div class="brandbar">${logo}<span class="w">req<i>-</i>kit</span><span class="series">${esc(series)}</span></div>`;

// ---------- poster 1080×1920 ----------
const top3 = highlights.slice(0, 3);
const stat = (value, label) => (value === undefined ? "" : `<div class="pst"><b>${esc(value)}</b><span>${esc(label)}</span></div>`);
const posterStats = [stat(numbers.releases, "个版本"), stat(numbers.tests, "项自动化测试"), stat(numbers.adrs, "份设计决定记录")].filter(Boolean).slice(0, 3);
const poster = page(
  `req-kit ${version} 海报`,
  `${shared}
.poster{width:1080px;height:1920px;padding:96px;display:flex;flex-direction:column}
.hero{font:800 112px/116px var(--rk-font-sans);letter-spacing:-.03em;margin:0}
.lead{font:500 32px/48px var(--rk-font-sans);color:var(--rk-text-secondary);margin:0}
.shot{position:relative;border-radius:20px;background:var(--rk-surface-2);border:1px solid var(--rk-border-default);box-shadow:var(--rk-shadow-dialog);overflow:hidden;padding:32px;display:flex;flex-direction:column;gap:18px}
.shot::before{content:"";position:absolute;left:0;right:0;top:0;height:2px;background:linear-gradient(90deg,transparent,var(--rk-campaign-lime),transparent)}
.row{display:flex;align-items:center;gap:22px;padding:18px 22px;border-radius:14px;background:var(--rk-surface-1);border:1px solid var(--rk-border-subtle)}
.row .tile{width:56px;height:56px;flex:none;border-radius:14px;display:grid;place-items:center;background:var(--rk-brand-tint);color:var(--rk-brand-text)}
.row .tile.ai{background:var(--rk-ai-tint);color:var(--rk-ai)}.row .tile.data{background:var(--rk-data-tint);color:var(--rk-data)}.row .tile.danger{background:var(--rk-failed-tint);color:var(--rk-status-failed)}
.row .tile .ic{width:28px;height:28px}
.row div{min-width:0;display:flex;flex-direction:column;gap:4px}
.row b{font:600 28px/36px var(--rk-font-sans);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row span{font:400 21px/30px var(--rk-font-sans);color:var(--rk-text-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.stats{display:flex;gap:16px}
.pst{flex:1;border-radius:18px;background:var(--rk-surface-2);border:1px solid var(--rk-border-default);padding:22px 20px;display:flex;flex-direction:column;align-items:center;gap:6px}
.pst b{font:700 64px/68px var(--rk-font-sans);letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.pst span{font:500 22px/30px var(--rk-font-sans);color:var(--rk-text-muted)}
.act{display:flex;flex-direction:column;gap:22px;margin-top:auto}
.act b{display:inline-flex;align-items:center;align-self:flex-start;height:76px;padding:0 32px;border-radius:12px;background:var(--rk-campaign-lime);color:var(--rk-on-campaign-lime);font:700 30px/1 var(--rk-font-mono);box-shadow:var(--rk-glow-brand)}
.cap{font:400 22px/32px var(--rk-font-sans);color:var(--rk-text-muted)}
`,
  `<div class="frame"><div class="art poster rk-aurora">
  <svg class="track" viewBox="0 0 1080 1920" aria-hidden="true">
    <polyline points="850,1620 960,1730 1300,1360" fill="none" stroke="var(--rk-campaign-lime)" stroke-width="3" opacity=".4"/>
    <circle cx="850" cy="1620" r="14" fill="var(--rk-canvas)" stroke="var(--rk-campaign-lime)" stroke-width="3" opacity=".7"/>
    <circle cx="960" cy="1730" r="14" fill="var(--rk-canvas)" stroke="var(--rk-campaign-lime)" stroke-width="3" opacity=".7"/>
    <circle cx="1046" cy="1636" r="22" fill="var(--rk-campaign-lime)"/>
  </svg>
  ${brandbar(version)}
  <div style="display:flex;flex-direction:column;gap:36px;margin-top:110px;position:relative">
    <span class="eb">Release ${esc(version)}</span>
    <h1 class="hero">${headline(title, "kw")}</h1>
    ${lead ? `<p class="lead">${esc(lead)}</p>` : ""}
  </div>
  ${
    top3.length
      ? `<div class="shot" style="margin-top:64px"><span class="rk-eyebrow" style="font-size:18px">What's new · ${highlights.length}</span>
    ${top3
      .map((h) => {
        const k = kind(h);
        return `<div class="row"><span class="tile ${k.tone}">${icon(k.ic)}</span><div><b>${esc(h.title)}</b><span>${esc(clip(h.text, 60))}</span></div></div>`;
      })
      .join("\n    ")}
  </div>`
      : ""
  }
  ${posterStats.length ? `<div class="stats" style="margin-top:40px">${posterStats.join("")}</div>` : ""}
  <div class="act">
    <span style="font:600 32px/44px var(--rk-font-sans)">第一个需求，我们陪你走完</span>
    <b>npx -y paseo-req-kit@latest install</b>
    <span class="cap">${esc(date)} 发布 · 只需要 npm 源，内网可用 · 文档：req docs</span>
  </div>
</div></div>`,
);

// ---------- chat card 1200×630 ----------
const card = page(
  `req-kit ${version} 群聊卡片`,
  `${shared}
.card{width:1200px;height:630px;padding:64px}
.card h1{margin:0;font:800 64px/76px var(--rk-font-sans);letter-spacing:-.02em}
.card p{margin:0;font:500 26px/40px var(--rk-font-sans);color:var(--rk-text-secondary)}
`,
  `<div class="frame"><div class="art card rk-aurora">
  <svg class="track" viewBox="0 0 1200 630" aria-hidden="true">
    <polyline points="800,420 930,550 1260,190" fill="none" stroke="var(--rk-campaign-lime)" stroke-width="3" opacity=".45"/>
    <circle cx="800" cy="420" r="12" fill="var(--rk-canvas)" stroke="var(--rk-campaign-lime)" stroke-width="3"/>
    <circle cx="930" cy="550" r="12" fill="var(--rk-canvas)" stroke="var(--rk-campaign-lime)" stroke-width="3"/>
    <circle cx="1100" cy="363" r="20" fill="var(--rk-campaign-lime)"/>
  </svg>
  ${brandbar(version)}
  <div style="position:relative;margin-top:72px;width:700px;display:flex;flex-direction:column;gap:22px">
    <h1>${headline(cardTitle.length > 20 ? `${version}\n*正式版*` : cardTitle, "kw")}</h1>
    ${lead ? `<p>${esc(clip(lead, 52))}</p>` : ""}
  </div>
</div></div>`,
);

// ---------- slides 1920×1080 ----------
const slides = [];
slides.push(`<section class="art slide rk-aurora cover">
  ${brandbar(version)}
  <div style="display:flex;flex-direction:column;gap:40px;max-width:1500px">
    <span class="eb">Release ${esc(version)}</span>
    <h1>${headline(title.replace(/\n/g, ""), "kw")}</h1>
    ${lead ? `<p class="sub">${esc(lead)}</p>` : ""}
  </div>
  <div class="meta">${esc(date)} · 正式版 · AI 探索小组</div>
</section>`);

const cardHtml = (h, span, textMax) => {
  const k = kind(h);
  const label = k.tone === "ai" ? "rk-card__label--ai" : k.tone === "data" ? "rk-card__label--data" : k.tone === "danger" ? "danger" : "";
  return `<article class="rk-card rk-span-${span}"><span class="rk-card__label ${label}">${icon(k.ic)}${h.fix ? "修复" : "新增"}</span><h3>${esc(h.title)}</h3><p>${esc(clip(h.text, textMax))}</p></article>`;
};
if (highlights.length) {
  const overview = highlights.slice(0, 6);
  const span = overview.length <= 2 ? 6 : 4;
  slides.push(`<section class="art slide">
  <div class="head"><span class="eb">What's new</span><h2>这一版带来 ${highlights.length} 项变化</h2>${summary ? `<p class="sub2">${esc(clip(summary, 90))}</p>` : ""}</div>
  <div class="rk-bento big compact">${overview.map((h) => cardHtml({ ...h, text: "" }, span, 0).replace("<p></p>", `<p>${esc(clip(h.text, 34))}</p>`)).join("")}</div>
</section>`);
  for (let i = 0; i < highlights.length; i += 2) {
    const pair = highlights.slice(i, i + 2);
    slides.push(`<section class="art slide">
  <div class="head"><span class="eb">Details ${i / 2 + 1} / ${Math.ceil(highlights.length / 2)}</span><h2>${esc(pair.map((h) => h.title).join("；"))}</h2></div>
  <div class="rk-bento big fill">${pair.map((h) => cardHtml(h, pair.length === 1 ? 12 : 6, 160)).join("")}</div>
</section>`);
  }
}
if (upgrade.length) {
  slides.push(`<section class="art slide">
  <div class="head"><span class="eb">Upgrade</span><h2>升级须知</h2></div>
  <ol class="notes">${upgrade.slice(0, 6).map((u, i) => `<li><b>${i + 1}</b><span>${esc(clip(u, 110))}</span></li>`).join("")}</ol>
</section>`);
}
const tiles = [
  [numbers.releases, "个版本", `截至 ${version}，其中 ${numbers.stable} 个正式版`],
  [numbers.tests, "项自动化测试", "Linux 和 Windows 都通过才发布"],
  [numbers.adrs, "份设计决定记录", "每个关键取舍都写明原因"],
].filter(([v]) => v !== undefined);
slides.push(`<section class="art slide">
  <div class="head"><span class="eb">Numbers</span><h2>每一版都经过同样的检查才发布</h2></div>
  <div class="rk-bento big fill">${tiles.map(([v, l, s]) => `<div class="rk-stat rk-span-${12 / tiles.length}"><b>${esc(v)}</b><strong>${esc(l)}</strong><span>${esc(s)}</span></div>`).join("")}</div>
</section>`);
slides.push(`<section class="art slide rk-aurora end">
  <div class="head"><span class="eb">Get started</span><h2>第一个需求，我们陪你走完</h2></div>
  <div class="rk-term"><div class="rk-term__tabs"><span class="is-on">安装或升级</span></div><div class="rk-term__body"><i>$</i><code>npx -y paseo-req-kit@latest install</code></div></div>
  <ol class="notes steps"><li><b>1</b><span>在运行 Paseo 的电脑上执行上面的命令；已经装过的运行 req upgrade。</span></li><li><b>2</b><span>在 Paseo 里输入 /req 和一句话需求，AI 一次问一个问题。</span></li><li><b>3</b><span>文档在本机打开：req docs。</span></li></ol>
</section>`);
const total = slides.length;
const slidesHtml = page(
  `req-kit ${version} 汇报`,
  `${shared}
.slide{width:1920px;height:1080px;padding:112px 128px 150px;display:flex;flex-direction:column;gap:48px}
.cover{justify-content:space-between}
.cover .brandbar svg{width:48px;height:48px}.cover .brandbar .w{font-size:38px}
.slide .eb{font-size:24px;line-height:32px}
.cover h1{margin:0;font:800 112px/124px var(--rk-font-sans);letter-spacing:-.03em}
.sub{margin:0;font:500 34px/52px var(--rk-font-sans);color:var(--rk-text-secondary)}
.sub2{margin:0;font:500 28px/42px var(--rk-font-sans);color:var(--rk-text-secondary);max-width:1500px}
.meta{font:400 24px/1 var(--rk-font-sans);color:var(--rk-text-muted)}
.head{display:flex;flex-direction:column;gap:20px}
.head h2{margin:0;font:700 64px/80px var(--rk-font-sans);letter-spacing:-.01em;max-width:1600px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.big{gap:24px}
.big .rk-card{padding:44px;gap:18px;border-radius:24px}
.big .rk-card h3{font-size:36px;line-height:48px}
.big .rk-card p{font-size:26px;line-height:42px}
.big.compact .rk-card{padding:32px 36px;gap:14px}
.big.compact .rk-card h3{font-size:30px;line-height:40px}
.big.compact .rk-card p{font-size:22px;line-height:34px}
.big .rk-card__label{height:36px;font-size:18px;padding:0 14px}
.big .rk-card__label .ic{width:20px;height:20px}
.rk-card__label.danger{background:var(--rk-failed-tint);color:var(--rk-status-failed)}
.big .rk-stat{padding:56px 32px;gap:12px;justify-content:center}
.big .rk-stat b{font-size:120px;line-height:124px}
.big .rk-stat strong{font-size:30px;line-height:40px}
.big .rk-stat span{font-size:22px;line-height:32px}
.notes{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:22px;max-width:1600px}
.notes li{display:flex;gap:28px;align-items:flex-start}
.notes b{flex:none;width:56px;font:700 44px/52px var(--rk-font-sans);color:var(--rk-brand-text);font-variant-numeric:tabular-nums}
.notes span{font:400 28px/44px var(--rk-font-sans);color:var(--rk-text-secondary)}
.end .rk-term{max-width:1200px}
.end .rk-term__tabs span{font-size:20px;padding:12px 20px 14px}
.end .rk-term__body{font-size:34px;line-height:48px;padding:28px 32px}
.no{position:absolute;right:128px;bottom:64px;font:400 22px/1 var(--rk-font-mono);color:var(--rk-text-muted)}
.fill{flex:1;min-height:0;grid-auto-rows:1fr}
.fill .rk-card{justify-content:flex-start}
.fill .rk-card p{font-size:30px;line-height:50px}
@media print{.frame{break-after:page}.kw{background:none;color:var(--rk-campaign-lime)}}
`,
  slides.map((s, i) => `<div class="frame">${s.replace(/<\/section>$/, `  <span class="no">${i + 1} / ${total}</span>\n</section>`)}</div>`).join("\n"),
);

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "poster.html"), poster);
fs.writeFileSync(path.join(out, "card.html"), card);
fs.writeFileSync(path.join(out, "slides.html"), slidesHtml);
const written = ["poster.html", "card.html", "slides.html"];

if (render) {
  const where = process.env.PLAYWRIGHT_DIR;
  const pw = await import(where ? pathToFileURL(path.join(where, "index.mjs")).href : "playwright");
  const browser = await pw.chromium.launch();
  try {
    const shoot = async (file, w, h, png) => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, colorScheme: "dark" });
      const p = await ctx.newPage();
      await p.goto(pathToFileURL(path.join(out, file)).href);
      await p.evaluate(() => document.documentElement.classList.add("print"));
      await p.locator(".art").first().screenshot({ path: path.join(out, png) });
      await ctx.close();
      written.push(png);
    };
    await shoot("poster.html", 1080, 1920, "poster.png");
    await shoot("card.html", 1200, 630, "card.png");
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
    const p = await ctx.newPage();
    await p.goto(pathToFileURL(path.join(out, "slides.html")).href);
    await p.evaluate(() => document.documentElement.classList.add("print"));
    await p.emulateMedia({ media: "print", colorScheme: "dark" });
    await p.pdf({ path: path.join(out, "slides.pdf"), width: "1920px", height: "1080px", printBackground: true, pageRanges: "" });
    await ctx.close();
    written.push("slides.pdf");
  } finally {
    await browser.close();
  }
}
console.log(`${version}: ${highlights.length} highlights, ${upgrade.length} upgrade notes → ${path.relative(process.cwd(), out) || "."}/{${written.join(",")}}`);
