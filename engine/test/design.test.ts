// 1.15: the review pages use the design system (design/). Their copies of the tokens, component
// styles and icons must match it, and the pages' own styles take colors from tokens only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const ASSETS = path.join(ROOT, "engine", "src", "review-assets");

test("审查网页里的设计系统副本和 design/ 一致（改了 design/ 要运行 node scripts/tokens-build.mjs）", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "tokens-build.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test("三个审查网页都加载设计系统，页面自己的样式不写死颜色", () => {
  for (const page of ["app", "check", "code"]) {
    const html = fs.readFileSync(path.join(ASSETS, `${page}.html`), "utf8");
    for (const file of ["rk-tokens.css", "rk.css", "rk-icons.js"]) assert.ok(html.includes(`"${file}"`), `${page}.html 没有加载 ${file}`);
    assert.ok(!/fonts\.googleapis/.test(html), `${page}.html 不能依赖外网字体（内网打不开）`);
    const css = fs.readFileSync(path.join(ASSETS, `${page}.css`), "utf8");
    // The prototype frame keeps a white ground (it is the product being designed, not req-kit).
    const raw = (css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).filter((c) => !/^#fff(fff)?$/i.test(c));
    assert.deepEqual(raw, [], `${page}.css 里有写死的颜色：${raw.join(" ")}`);
  }
});

test("Paseo 插件的颜色只来自 Paseo 主题和生成的 rk-colors.ts", () => {
  const dir = path.join(ROOT, "paseo-plugin", "client");
  for (const f of fs.readdirSync(dir).filter((x) => /\.tsx?$/.test(x))) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    const raw = src.match(/["'`]#[0-9a-fA-F]{3,8}\b/g) ?? [];
    assert.deepEqual(raw, [], `paseo-plugin/client/${f} 里有写死的颜色：${raw.join(" ")}`);
  }
});

test("文档站的主题样式只用设计系统的变量", () => {
  const theme = path.join(ROOT, "site", ".vitepress", "theme");
  for (const f of ["custom.css", "components/RkHome.vue", "components/RkIcon.vue"]) {
    const src = fs.readFileSync(path.join(theme, f), "utf8").replace(/url\("data:[^"]*"\)/g, "");
    const raw = src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    assert.deepEqual(raw, [], `site/.vitepress/theme/${f} 里有写死的颜色：${raw.join(" ")}`);
  }
});

test("正式版的海报、群聊卡片和幻灯片从更新记录生成，不依赖外网", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "rk-media-"));
  const script = path.join(ROOT, "scripts", "release-media.mjs");
  const r = spawnSync(process.execPath, [script, "1.14.0", "--out", out, "--tests", "241", "--date", "2026-10-25"], { encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const slides = fs.readFileSync(path.join(out, "slides.html"), "utf8");
  const poster = fs.readFileSync(path.join(out, "poster.html"), "utf8");
  assert.match(poster, /插件里/);
  assert.match(poster, />241</);
  assert.match(slides, /这一版带来 7 项变化/);
  assert.match(slides, /升级须知/);
  assert.match(slides, /代码审查/);
  for (const html of [slides, poster, fs.readFileSync(path.join(out, "card.html"), "utf8")]) {
    assert.ok(!/(src|href)="https?:/.test(html), "生成的页面不能引用外网资源");
    assert.ok(!/rk-icons|tokens\.css"/.test(html), "样式和图标要内联");
  }
  const beta = spawnSync(process.execPath, [script, "1.14.0-beta.5", "--out", out], { encoding: "utf8" });
  assert.equal(beta.status, 2, "beta 默认不生成");
});
