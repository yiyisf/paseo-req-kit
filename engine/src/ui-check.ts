// `req ui-check` (1.13): checks a web page without looking at it. Opens the page in this machine's
// Edge or Chrome (headless, through playwright-core; no browser download), at each width, and
// reports in words what a person would notice: things cut off, on top of each other, sticking
// out of the screen, images not loading, text too pale to read, controls without a name,
// console errors and failed requests. With --prototype it also compares the page's labels
// (titles, buttons, field names, table headers) with the confirmed prototype. Screenshots go to
// files for people, not to the model: models with weak vision gain little from them and pay
// for every image in tokens.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ENGINE_DIR, KIT_ROOT, kitHome } from "./locations.js";

const PLAYWRIGHT_VERSION = "1.56.1";
const PAGE_SCRIPT = path.join(ENGINE_DIR, "src", "ui-check-page.js");

export interface Target {
  kind: string;
  text: string;
  selector: string;
  box: { x: number; y: number; w: number; h: number };
}

export interface Issue {
  kind: "overflow" | "clipped" | "overlap" | "offscreen" | "broken_image" | "small_target" | "low_contrast" | "no_label" | "no_name";
  target: Target | null;
  detail: Record<string, unknown> & { other?: Target };
}

export interface PageFindings {
  width: number;
  height: number;
  title: string;
  issues: Issue[];
  labels: string[];
}

/** The in-page check as a function expression (also what an agent passes to browser_evaluate). */
export function pageScript(): string {
  const src = fs.readFileSync(PAGE_SCRIPT, "utf8");
  const start = src.indexOf("(function");
  return src.slice(start).trim().replace(/;\s*$/, "");
}

// ---------------------------------------------------------------------------
// Words

const who = (t: Target | null | undefined) => (t ? `${t.kind}${t.text ? `"${t.text.slice(0, 30)}${t.text.length > 30 ? "…" : ""}"` : ""}` : "页面");

export function issueText(i: Issue): string {
  const d = i.detail;
  switch (i.kind) {
    case "overflow":
      return `超出屏幕：${who(i.target)} 右边超出 ${d.overBy}px，会出现横向滚动条`;
    case "clipped":
      return `文字显示不全：${who(i.target)}（可见宽 ${d.shown}px，需要 ${d.needed}px）`;
    case "overlap":
      return `互相遮挡：${who(i.target)} 和 ${who(d.other)} 重叠了 ${(d.area as { w: number }).w}×${(d.area as { h: number }).h}px`;
    case "offscreen":
      return `跑到页面外：${who(i.target)} 在左边或上边看不到的地方`;
    case "broken_image":
      return `图片没有加载出来：${d.src || who(i.target)}`;
    case "small_target":
      return `太小不好点：${who(i.target)} 只有 ${d.w}×${d.h}px（手机上建议至少 24×24）`;
    case "low_contrast":
      return `文字太淡看不清：${who(i.target)}（${d.color} 在 ${d.background} 上，对比度 ${d.ratio}:1，至少要 ${d.need}:1）`;
    case "no_label":
      return `输入框没有名字：${who(i.target)} 旁边没有标签或提示文字`;
    case "no_name":
      return `按钮或链接没有文字：${who(i.target)}（只有图标时要有提示文字）`;
    default:
      return `${i.kind}：${who(i.target)}`;
  }
}

/** Labels in the prototype and not on the page (and the other way round). */
export function compareLabels(prototype: string[], page: string[]): { missing: string[]; extra: string[] } {
  const norm = (s: string) => s.replace(/\s+/g, "").replace(/[：:]$/, "").toLowerCase();
  const pageSet = new Set(page.map(norm));
  const protoSet = new Set(prototype.map(norm));
  return {
    missing: prototype.filter((t) => !pageSet.has(norm(t))),
    extra: page.filter((t) => !protoSet.has(norm(t))),
  };
}

// ---------------------------------------------------------------------------
// The browser

interface Pw {
  chromium: {
    launch(o: Record<string, unknown>): Promise<{
      newPage(o: Record<string, unknown>): Promise<PwPage>;
      close(): Promise<void>;
    }>;
  };
}
interface PwPage {
  goto(url: string, o?: Record<string, unknown>): Promise<unknown>;
  evaluate<T>(src: string): Promise<T>;
  screenshot(o: Record<string, unknown>): Promise<unknown>;
  on(event: string, fn: (x: never) => void): void;
  setViewportSize(s: { width: number; height: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  getByText(t: string, o?: Record<string, unknown>): { first(): { waitFor(o?: Record<string, unknown>): Promise<void> } };
  locator(s: string): { first(): { click(): Promise<void>; fill(v: string): Promise<void>; selectOption(v: string): Promise<unknown>; press(k: string): Promise<void>; waitFor(o?: Record<string, unknown>): Promise<void> } };
  close(): Promise<void>;
}

const toolsDir = (env: NodeJS.ProcessEnv) => path.join(kitHome(env), "tools");

function tryRequire(from: string): Pw | null {
  try {
    return createRequire(path.join(from, "noop.js"))("playwright-core") as Pw;
  } catch {
    return null;
  }
}

/** playwright-core: next to req-kit, in ~/.req-kit/tools, or installed there now (from the npm registry or mirror). */
export function loadPlaywright(env: NodeJS.ProcessEnv = process.env, log: (s: string) => void = (s) => console.error(s)): Pw {
  const found = tryRequire(KIT_ROOT) ?? tryRequire(toolsDir(env));
  if (found) return found;
  log(`第一次使用界面检查：安装 playwright-core@${PLAYWRIGHT_VERSION} 到 ${toolsDir(env)}（只装驱动，用本机的 Edge 或 Chrome，不下载浏览器）……`);
  fs.mkdirSync(toolsDir(env), { recursive: true });
  const windows = process.platform === "win32";
  const r = spawnSync(windows ? "npm.cmd" : "npm", ["install", "--prefix", toolsDir(env), "--no-audit", "--no-fund", "--no-save", `playwright-core@${PLAYWRIGHT_VERSION}`], {
    stdio: ["ignore", "inherit", "inherit"],
    shell: windows,
    env: { ...env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
    timeout: 600_000,
  });
  const loaded = r.status === 0 ? tryRequire(toolsDir(env)) : null;
  if (!loaded) throw new Error(`没能安装 playwright-core（npm 退出码 ${r.status}）。请检查 npm 源（npm config get registry），或手动运行：npm install --prefix "${toolsDir(env)}" playwright-core@${PLAYWRIGHT_VERSION}`);
  return loaded;
}

/** This machine's Edge or Chrome; REQ_KIT_BROWSER / --browser names a browser program directly. */
export async function launchBrowser(pw: Pw, executable: string | null) {
  const tries: Array<Record<string, unknown>> = executable ? [{ executablePath: executable }] : [{ channel: "msedge" }, { channel: "chrome" }, {}];
  const errors: string[] = [];
  for (const t of tries) {
    try {
      return await pw.chromium.launch({ headless: true, ...t });
    } catch (error) {
      errors.push(`${JSON.stringify(t)}：${(error as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(`没有找到能用的浏览器（Edge 或 Chrome）。装好其中一个，或用 --browser <浏览器程序路径> 指定。\n${errors.join("\n")}`);
}

export interface Step {
  goto?: string;
  click?: string;
  fill?: [string, string];
  select?: [string, string];
  press?: [string, string];
  wait?: string;
}

async function runSteps(page: PwPage, steps: Step[]) {
  for (const s of steps) {
    if (s.goto) await page.goto(s.goto, { waitUntil: "load" });
    else if (s.click) await page.locator(s.click).first().click();
    else if (s.fill) await page.locator(s.fill[0]).first().fill(s.fill[1]);
    else if (s.select) await page.locator(s.select[0]).first().selectOption(s.select[1]);
    else if (s.press) await page.locator(s.press[0]).first().press(s.press[1]);
    else if (s.wait) await page.locator(s.wait).first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(150);
  }
}

export interface CheckOptions {
  url: string;
  widths: number[];
  prototype: string | null;
  state: string | null;
  steps: Step[];
  shots: string | null;
  browser: string | null;
  env?: NodeJS.ProcessEnv;
}

export interface WidthReport {
  width: number;
  findings: PageFindings;
  console: string[];
  failedRequests: string[];
  screenshot: string | null;
}

export interface CheckReport {
  url: string;
  widths: WidthReport[];
  prototype: { file: string; state: string | null; missing: string[]; extra: string[] } | null;
}

export async function check(opts: CheckOptions): Promise<CheckReport> {
  const env = opts.env ?? process.env;
  const pw = loadPlaywright(env);
  const browser = await launchBrowser(pw, opts.browser ?? env.REQ_KIT_BROWSER?.trim() ?? null);
  const script = pageScript();
  try {
    const widths: WidthReport[] = [];
    for (const width of opts.widths) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const consoleErrors: string[] = [];
      const failed: string[] = [];
      page.on("console", (m: { type(): string; text(): string }) => {
        if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
      });
      page.on("pageerror", (e: Error) => consoleErrors.push(e.message.slice(0, 300)));
      page.on("requestfailed", (r: { method(): string; url(): string; failure(): { errorText: string } | null }) => failed.push(`${r.method()} ${r.url().slice(0, 160)}（${r.failure()?.errorText ?? "失败"}）`));
      page.on("response", (r: { status(): number; request(): { method(): string }; url(): string }) => {
        if (r.status() >= 400) failed.push(`${r.request().method()} ${r.url().slice(0, 160)} → ${r.status()}`);
      });
      await page.goto(opts.url, { waitUntil: "networkidle", timeout: 45_000 }).catch(async (e: Error) => {
        if (!/Timeout/.test(e.message)) throw e;
      });
      await runSteps(page, opts.steps);
      await page.waitForTimeout(300);
      const findings = await page.evaluate<PageFindings>(`(${script})(${JSON.stringify({ width, narrow: width <= 480, state: null })})`);
      let shot: string | null = null;
      if (opts.shots) {
        fs.mkdirSync(opts.shots, { recursive: true });
        const u = new URL(opts.url);
        const last = (u.protocol === "file:" ? path.basename(u.pathname).replace(/\.html?$/i, "") : u.pathname.split("/").filter(Boolean).slice(-2).join("-")) || "page";
        const name = `${last.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, "-").slice(0, 60)}-${width}.png`;
        shot = path.join(opts.shots, name);
        await page.screenshot({ path: shot, fullPage: true });
      }
      widths.push({ width, findings, console: [...new Set(consoleErrors)], failedRequests: [...new Set(failed)], screenshot: shot });
      await page.close();
    }
    let prototype: CheckReport["prototype"] = null;
    if (opts.prototype) {
      // The prototype's own scripts (there should be none) are dropped; the check needs JavaScript.
      const p2 = await browser.newPage({ viewport: { width: opts.widths[0] ?? 1280, height: 900 } });
      const html = fs.readFileSync(opts.prototype, "utf8").replace(/<script\b[\s\S]*?<\/script>/gi, "");
      await p2.goto("about:blank");
      await p2.evaluate(`document.open(); document.write(${JSON.stringify(html)}); document.close();`);
      const protoFindings = await p2.evaluate<PageFindings>(`(${script})(${JSON.stringify({ width: opts.widths[0] ?? 1280, narrow: false, state: opts.state })})`);
      await p2.close();
      const pageLabels = [...new Set(widths.flatMap((w) => w.findings.labels))];
      const { missing, extra } = compareLabels(protoFindings.labels, pageLabels);
      prototype = { file: opts.prototype, state: opts.state, missing, extra };
    }
    return { url: opts.url, widths, prototype };
  } finally {
    await browser.close();
  }
}

const WIDTH_NAME: Record<number, string> = { 1280: "电脑", 1440: "电脑", 1920: "大屏", 768: "平板", 390: "手机", 375: "手机", 414: "手机" };

export function reportText(r: CheckReport): { text: string; problems: number } {
  const out: string[] = [];
  let problems = 0;
  for (const w of r.widths) {
    out.push(`## ${WIDTH_NAME[w.width] ?? ""}宽度 ${w.width}px：${r.url}`);
    out.push(`页面标题：${w.findings.title || "（无）"}；页面高度 ${w.findings.height}px`);
    if (w.console.length) {
      problems += w.console.length;
      out.push(`控制台报错（${w.console.length}）：`, ...w.console.slice(0, 10).map((c) => `- ${c}`));
    }
    if (w.failedRequests.length) {
      problems += w.failedRequests.length;
      out.push(`请求失败（${w.failedRequests.length}）：`, ...w.failedRequests.slice(0, 10).map((c) => `- ${c}`));
    }
    if (w.findings.issues.length) {
      problems += w.findings.issues.length;
      out.push(`版面问题（${w.findings.issues.length}）：`, ...w.findings.issues.slice(0, 30).map((i) => `- ${issueText(i)}${i.target ? `  [${i.target.selector}]` : ""}`));
    } else out.push("版面问题：没有发现");
    if (w.screenshot) out.push(`截图（给人看）：${w.screenshot}`);
    out.push("");
  }
  if (r.prototype) {
    const p = r.prototype;
    out.push(`## 和原型对文字：${p.file}${p.state ? `，状态"${p.state}"` : ""}`);
    if (p.missing.length) {
      problems += p.missing.length;
      out.push(`原型里有、页面上没有（${p.missing.length}）：${p.missing.slice(0, 30).map((t) => `"${t}"`).join("、")}`);
    } else out.push("原型里的标题、按钮、字段名、表头在页面上都找到了。");
    if (p.extra.length) out.push(`页面上有、原型里没有（多数是原型没画的部分，核对一下是否应该有）：${p.extra.slice(0, 20).map((t) => `"${t}"`).join("、")}`);
    out.push("");
  }
  out.push(problems === 0 ? "结论：没有发现问题。" : `结论：发现 ${problems} 处需要核对的地方。逐条判断是不是真的问题（有的是故意的设计），是的按缺陷处理。`);
  return { text: out.join("\n"), problems };
}

// ---------------------------------------------------------------------------
// req ui-check <网址> [选项]

const HELP = `用法：req ui-check <网址> [选项]

不靠看图检查网页：用本机的 Edge 或 Chrome 打开页面，按每个宽度用文字报告看得出来的问题
（文字显示不全、互相遮挡、超出屏幕、图片没加载、文字太淡、控件没有名字、控制台报错、请求失败）。

  --width 1280,390          检查的宽度（默认电脑 1280 和手机 390）
  --prototype <原型文件>    和确认过的原型对文字：标题、按钮、字段名、表头、提示语
  --state <状态名>          原型中 data-state 的状态（如"空数据"），对文字时只看这个状态
  --steps <文件.json>       打开后先做的操作，例如 [{"fill":["#keyword","手机"]},{"click":"text=查询"},{"wait":"text=共 3 条"}]
  --shots <目录>            把整页截图存到这个目录（给人看；不要再把截图读给模型）
  --browser <程序路径>      指定浏览器（默认找本机的 Edge，再找 Chrome；也可以设 REQ_KIT_BROWSER）
  --json                    输出 JSON
  --script                  只输出页面检查脚本（在 Paseo 浏览器的 browser_evaluate 中用）

退出码：0 没有发现问题，1 发现需要核对的地方，2 没能检查（打不开页面、没有浏览器等）。`;

function option(argv: string[], name: string): string | null {
  const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return null;
  const a = argv[i];
  return a.includes("=") ? a.slice(name.length + 1) : (argv[i + 1] ?? null);
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  if (argv.includes("--script")) {
    console.log(pageScript());
    return 0;
  }
  const valued = new Set(["--width", "--prototype", "--state", "--steps", "--shots", "--browser"]);
  const url = argv.find((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1] ?? ""));
  if (!url) {
    console.error(HELP);
    return 2;
  }
  const widths = (option(argv, "--width") ?? "1280,390")
    .split(/[,，\s]+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 200 && n <= 4000);
  const stepsFile = option(argv, "--steps");
  const prototype = option(argv, "--prototype");
  if (prototype && !fs.existsSync(prototype)) {
    console.error(`没有这个原型文件：${prototype}`);
    return 2;
  }
  const report = await check({
    url: /^[a-z]+:\/\//i.test(url) ? url : fs.existsSync(url) ? pathToFileURL(path.resolve(url)).href : `http://${url}`,
    widths: widths.length ? widths : [1280, 390],
    prototype,
    state: option(argv, "--state"),
    steps: stepsFile ? (JSON.parse(fs.readFileSync(stepsFile, "utf8")) as Step[]) : [],
    shots: option(argv, "--shots"),
    browser: option(argv, "--browser"),
  });
  const { text, problems } = reportText(report);
  console.log(argv.includes("--json") ? JSON.stringify(report, null, 2) : text);
  return problems === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: Error) => {
      console.error(`没能检查：${error.message}`);
      process.exit(2);
    },
  );
}
