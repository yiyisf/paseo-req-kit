// The prototype review page (1.13): a small web server on this machine where the requester
// looks at the interface prototype of a requirement, clicks on what they want changed (the page
// records which element, its text, color, size and position, so nobody has to describe it in
// technical words), edits texts in place, and then sends the list to the requirement's chat or
// confirms the design. The Paseo plugin links to it; `req review <需求>` opens it from a terminal.
//
// One server per machine, started on demand and stopped after a few idle hours. It listens on
// 127.0.0.1 only and every address carries a random token (a second token gives a read-only
// page). REQ_KIT_REVIEW_HOST / REQ_KIT_REVIEW_PORT / REQ_KIT_REVIEW_PUBLIC_URL change that, e.g.
// when people open Paseo's web UI from other computers.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { ENGINE_DIR, KIT_ROOT, kitHome, kitVersion } from "./locations.js";
import { buildCodeReview, recordHumanReview, startReviewFix, type Submission } from "./code-review.js";
import { type Answer, acceptanceFailMessage, acceptanceText, buildChecklist, recordAcceptance, verdictOf } from "./checklist.js";
import { appendEvent, readIndex, requirementRef } from "./records.js";
import { readState, statePath } from "./state.js";

const ASSETS = path.join(ENGINE_DIR, "src", "review-assets");
/** 1.15: the design system's tokens, component styles and icons, shared by the three pages (copies made by scripts/tokens-build.mjs). */
const SHARED_ASSETS = new Set(["rk-tokens.css", "rk.css", "rk-icons.js"]);
const DEFAULT_PORT = 6781;
const IDLE_EXIT_MS = 4 * 60 * 60_000;
const MAX_BODY = 2_000_000;
const MAX_MESSAGE = 7_500;

// ---------------------------------------------------------------------------
// What the page shows

export interface Criterion {
  id: string;
  text: string;
}

/** The acceptance criteria in spec.md: "AC-1.2 …" or "**AC-1.2**：…", first mention of each. */
export function specCriteria(spec: string): Criterion[] {
  const out = new Map<string, string>();
  for (const line of spec.split(/\r?\n/)) {
    const m = /\b(AC-\d+(?:\.\d+)*)\b[\s*_`)）\]】:：-]*(.*)$/.exec(line);
    if (!m || out.has(m[1])) continue;
    out.set(m[1], m[2].replace(/[*`_]/g, "").replace(/^[\s|:：-]+/, "").replace(/[\s|]+$/, "").trim().slice(0, 200));
  }
  return [...out.entries()].map(([id, text]) => ({ id, text }));
}

function specTitle(spec: string, fallback: string): string {
  const h = /^#\s+(.+)$/m.exec(spec);
  return (h?.[1] ?? fallback).replace(/^需求说明[:：\s]*/, "").trim() || fallback;
}

/** The HTML pages of a prototype directory (relative, "/"-separated), with their <title>. */
export function prototypeFiles(dir: string): Array<{ path: string; title: string }> {
  const out: Array<{ path: string; title: string }> = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.html?$/i.test(e.name)) {
        const rel = path.relative(dir, full).split(path.sep).join("/");
        const title = /<title>([^<]*)<\/title>/i.exec(fs.readFileSync(full, "utf8"))?.[1]?.trim();
        out.push({ path: rel, title: title || rel });
      }
    }
  };
  walk(dir);
  return out;
}

/** A short fingerprint of everything in a directory (names and contents). */
export function dirHash(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const h = crypto.createHash("sha256");
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        h.update(path.relative(dir, full).split(path.sep).join("/"));
        h.update("\0");
        h.update(fs.readFileSync(full));
        h.update("\0");
      }
    }
  };
  walk(dir);
  return h.digest("hex").slice(0, 12);
}

/**
 * Keeps a copy of each prototype version the page has shown (in .pipeline/review/versions), so
 * a revised prototype can be compared with the one the requester commented on.
 */
export function snapshotVersion(prototypeDir: string, reviewDir: string, now = new Date()): { current: string | null; previous: string | null } {
  const current = dirHash(prototypeDir);
  if (!current) return { current: null, previous: null };
  const listFile = path.join(reviewDir, "versions.json");
  let list: Array<{ hash: string; at: string }> = [];
  try {
    list = JSON.parse(fs.readFileSync(listFile, "utf8"));
  } catch {
    list = [];
  }
  if (list.at(-1)?.hash !== current) {
    const dest = path.join(reviewDir, "versions", current);
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(prototypeDir, dest, { recursive: true });
    }
    list = [...list.filter((v) => v.hash !== current), { hash: current, at: now.toISOString() }];
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(listFile, JSON.stringify(list, null, 2));
  }
  const i = list.findIndex((v) => v.hash === current);
  return { current, previous: i > 0 ? list[i - 1].hash : null };
}

// ---------------------------------------------------------------------------
// Turning clicks into a list the chat (and the design step) can act on

export type CommentKind = "text" | "bigger" | "smaller" | "color" | "move" | "remove" | "add" | "other";

export interface ReviewComment {
  id: string;
  file: string;
  state?: string | null;
  width?: number | null;
  kind: CommentKind;
  note?: string;
  newText?: string;
  target?: {
    desc?: string;
    text?: string;
    selector?: string;
    region?: { ac?: string | null; label?: string | null; index?: number | null } | null;
    styles?: { color?: string; background?: string; fontSize?: string; size?: string } | null;
  } | null;
}

const KIND_TEXT: Record<CommentKind, string> = {
  text: "改文字",
  bigger: "放大一点",
  smaller: "缩小一点",
  color: "换颜色",
  move: "换位置",
  remove: "删掉",
  add: "在这里加东西",
  other: "其他修改",
};

const clip = (s: string | undefined | null, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** Plain text for the chat: where, what was clicked (with its look), what to change. */
export function composeFeedback(comments: ReviewComment[], general: string | undefined, widths: Record<number, string> = { 1280: "电脑", 768: "平板", 390: "手机" }): string {
  const lines: string[] = [];
  lines.push(`来自原型审查页的修改意见（共 ${comments.length} 条${general?.trim() ? "，另有总体意见" : ""}）。`);
  lines.push(
    '请据此修改需求说明（changes.md 中原因写"方案确认时的修改"），把要改的地方讲给用户确认后再继续；元素的颜色、大小等是原型里的现状，供定位用。只有意思不清楚时才追问。',
  );
  if (general?.trim()) lines.push("", `总体意见：${clip(general, 800)}`);
  comments.forEach((c, i) => {
    const where = [`原型 ${c.file}`];
    if (c.state) where.push(`状态"${c.state}"`);
    if (c.width) where.push(`${widths[c.width] ?? ""}宽度 ${c.width}px`.trim());
    const r = c.target?.region;
    if (r && (r.ac || r.label)) where.push(`区域${r.index ? ` ${r.index}` : ""}${r.label ? `「${clip(r.label, 40)}」` : ""}${r.ac ? `（${r.ac}）` : ""}`);
    lines.push("", `${i + 1}. 位置：${where.join("，")}`);
    const t = c.target;
    if (t?.desc || t?.text) {
      const look = [
        t.styles?.color ? `文字颜色 ${t.styles.color}` : "",
        t.styles?.background ? `背景 ${t.styles.background}` : "",
        t.styles?.fontSize ? `字号 ${t.styles.fontSize}` : "",
        t.styles?.size ? `大小 ${t.styles.size}` : "",
      ].filter(Boolean);
      lines.push(`   点的是：${clip(t.desc, 30) || "元素"}${t.text ? `"${clip(t.text, 60)}"` : ""}${look.length ? `（${look.join("，")}）` : ""}`);
    }
    if (c.kind === "text") lines.push(`   要改：文字改为"${clip(c.newText, 300)}"${t?.text ? `（原来是"${clip(t.text, 120)}"）` : ""}`);
    else lines.push(`   要改：${KIND_TEXT[c.kind] ?? KIND_TEXT.other}${c.newText ? `，改为"${clip(c.newText, 300)}"` : ""}`);
    if (c.note?.trim()) lines.push(`   说明：${clip(c.note, 500)}`);
  });
  let text = lines.join("\n");
  if (text.length > MAX_MESSAGE) {
    text = `${text.slice(0, MAX_MESSAGE)}\n……（意见太长，后面的没有转达，完整内容在 .pipeline/review/submitted 中最新的文件里）`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// The server

export interface ReviewServerOptions {
  token: string;
  readToken: string;
  env?: NodeJS.ProcessEnv;
  /** Runs `req approve|reply …` in the requirement's checkout; tests replace it. */
  run?: (command: "approve" | "reply", repo: string, featureDir: string, extra: string[]) => { ok: boolean; message: string };
  /** 1.14: `req review-fix <需求>` after the code review page asked for changes; tests replace it. */
  codeFix?: (repo: string, featureDir: string) => { ok: boolean; message: string };
  /** 1.14: `req try <需求> --json [--stop]` for the checklist page's "试用" button; tests replace it. */
  tryRun?: (repo: string, featureDir: string, stop: boolean) => { ok: boolean; message: string; services?: unknown[]; howTo?: string[] };
  onRequest?: () => void;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** A path inside `base`, or null when the request tries to leave it. */
function inside(base: string, rel: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  const target = path.resolve(base, `.${path.posix.normalize(`/${decoded}`)}`);
  return target === base || target.startsWith(base + path.sep) ? target : null;
}

// The page may be shown inside Paseo (the req-kit plugin embeds it): Paseo's web UI on this
// machine, or, with REQ_KIT_REVIEW_HOST set for other computers, any page that has the token.
function appCsp(): string {
  const host = process.env.REQ_KIT_REVIEW_HOST?.trim();
  const local = !host || host === "127.0.0.1" || host === "localhost" || host === "::1";
  const custom = process.env.REQ_KIT_REVIEW_FRAME_ANCESTORS?.trim();
  // 'self' always: the page shows the prototype in a frame of its own.
  const ancestors = custom ? (custom.includes("'self'") || custom === "*" ? custom : `'self' ${custom}`) : local ? "'self' http://127.0.0.1:* http://localhost:*" : "*";
  return `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors ${ancestors}`;
}
const APP_CSP = appCsp();
// Prototypes are written by an agent (from text the requester or a card supplied) and are served
// next to the page's own API, so nothing in them may run: the page reads them from outside.
// frame-ancestors is checked against every page above, so the prototype allows the same ones as
// the review page (Paseo around it).
const PROTOTYPE_CSP = `default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self' data:; script-src 'none'; form-action 'none'; ${APP_CSP.slice(APP_CSP.indexOf("frame-ancestors"))}`;

function send(res: http.ServerResponse, status: number, body: string | Buffer, type = "text/plain; charset=utf-8", csp = APP_CSP) {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": csp,
  });
  res.end(body);
}

const json = (res: http.ServerResponse, status: number, value: unknown) => send(res, status, JSON.stringify(value), TYPES[".json"]);

function sendFile(res: http.ServerResponse, file: string | null, csp = APP_CSP) {
  if (!file) return send(res, 404, "没有这个文件");
  try {
    if (!fs.statSync(file).isFile()) return send(res, 404, "没有这个文件");
  } catch {
    return send(res, 404, "没有这个文件");
  }
  send(res, 200, fs.readFileSync(file), TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", csp);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("内容太大");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

/** `req <approve|reply> <需求> …` in the requirement's checkout, as `req api run` does (api.ts imports this file). */
function defaultRun(command: "approve" | "reply", repo: string, featureDir: string, extra: string[]) {
  const env = { ...process.env };
  delete env.PASEO_AGENT_ID;
  delete env.PASEO_AGENT_CWD;
  const r = spawnSync(process.execPath, [path.join(KIT_ROOT, "bin", "req.mjs"), command, featureDir, ...extra], {
    cwd: repo,
    env,
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
  });
  return { ok: r.status === 0, message: r.error ? r.error.message : `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function defaultTry(repo: string, featureDir: string, stop: boolean) {
  const env = { ...process.env };
  delete env.PASEO_AGENT_ID;
  delete env.PASEO_AGENT_CWD;
  const r = spawnSync(process.execPath, [path.join(KIT_ROOT, "bin", "req.mjs"), "try", featureDir, "--json", ...(stop ? ["--stop"] : [])], {
    cwd: repo,
    env,
    encoding: "utf8",
    timeout: 300_000,
    windowsHide: true,
  });
  try {
    return JSON.parse((r.stdout ?? "").trim().split("\n").at(-1) ?? "") as { ok: boolean; message: string; services?: unknown[]; howTo?: string[] };
  } catch {
    return { ok: false, message: r.error ? r.error.message : `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || "没有启动" };
  }
}

export function createReviewServer(opts: ReviewServerOptions): http.Server {
  const env = opts.env ?? process.env;
  const run = opts.run ?? defaultRun;
  const tryRun = opts.tryRun ?? defaultTry;
  const codeFixRun = opts.codeFix ?? startReviewFix;
  return http.createServer((req, res) => {
    opts.onRequest?.();
    handle(req, res).catch((error: Error) => json(res, 500, { ok: false, message: error.message }));
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/");
    // /r/<token>/health · /r/<token>/f/<key>/<rest…>
    if (parts[1] !== "r" || !parts[2]) return send(res, 404, "没有这个页面");
    const full = sameToken(parts[2], opts.token);
    if (!full && !sameToken(parts[2], opts.readToken)) return send(res, 403, "链接无效或已过期，请从 Paseo 的 req-kit 插件或 req review 重新打开");
    if (parts[3] === "health") return json(res, 200, { ok: true, version: kitVersion() });
    if (parts[3] !== "f" || !parts[4]) return send(res, 404, "没有这个页面");
    const entry = readIndex(env).find((e) => e.key === parts[4]);
    if (!entry) return send(res, 404, "这台机器上没有这个需求（需求列表中找不到）");
    const rest = parts.slice(5).join("/");
    const featureAbs = path.join(entry.repo, entry.featureDir);
    const prototypeDir = path.join(featureAbs, "prototype");
    const reviewDir = path.join(featureAbs, ".pipeline", "review");

    if (rest === "" && parts.length === 5) {
      res.writeHead(301, { location: `${url.pathname}/` });
      return res.end();
    }
    if (rest === "check") {
      res.writeHead(301, { location: `${url.pathname}/` });
      return res.end();
    }
    if (rest.startsWith("check/")) return handleChecklist(req, res, rest.slice("check/".length), entry, featureAbs, full);
    if (rest === "code") {
      res.writeHead(301, { location: `${url.pathname}/` });
      return res.end();
    }
    if (rest.startsWith("code/")) return handleCodeReview(req, res, rest.slice("code/".length), entry, featureAbs, full);
    if (rest === "") return sendFile(res, path.join(ASSETS, "app.html"));
    if (rest === "app.js" || rest === "app.css" || SHARED_ASSETS.has(rest)) return sendFile(res, path.join(ASSETS, rest));
    if (rest.startsWith("proto/cur/")) return sendFile(res, inside(prototypeDir, rest.slice("proto/cur/".length)), PROTOTYPE_CSP);
    if (rest.startsWith("proto/v/")) {
      const [hash, ...file] = rest.slice("proto/v/".length).split("/");
      if (!/^[0-9a-f]{12}$/.test(hash)) return send(res, 404, "没有这个版本");
      return sendFile(res, inside(path.join(reviewDir, "versions", hash), file.join("/")), PROTOTYPE_CSP);
    }

    if (rest === "api/info" && req.method === "GET") {
      let spec = "";
      try {
        spec = fs.readFileSync(path.join(featureAbs, "spec.md"), "utf8");
      } catch {
        /* shown without criteria */
      }
      const state = readState(statePath(entry.repo, entry.featureDir));
      const versions = fs.existsSync(prototypeDir) ? snapshotVersion(prototypeDir, reviewDir) : { current: null, previous: null };
      return json(res, 200, {
        key: entry.key,
        project: entry.project,
        featureDir: entry.featureDir,
        title: specTitle(spec, path.basename(entry.featureDir)),
        status: state?.status ?? null,
        waitingForApproval: state?.status === "waiting_for_approval",
        waitingForReply: state?.status === "waiting_for_approval" || state?.status === "waiting_for_business",
        canReply: Boolean(state?.originAgentId),
        readOnly: !full,
        files: fs.existsSync(prototypeDir) ? prototypeFiles(prototypeDir) : [],
        criteria: specCriteria(spec),
        versions,
      });
    }
    if (rest === "api/draft") {
      const file = path.join(reviewDir, "draft.json");
      if (req.method === "GET") {
        try {
          return json(res, 200, JSON.parse(fs.readFileSync(file, "utf8")));
        } catch {
          return json(res, 200, { comments: [], general: "" });
        }
      }
      if (req.method === "PUT") {
        if (!full) return json(res, 403, { ok: false, message: "这是只读链接" });
        const body = (await readBody(req)) as { comments?: unknown; general?: unknown } | null;
        if (!body || !Array.isArray(body.comments)) return json(res, 400, { ok: false, message: "格式不对" });
        fs.mkdirSync(reviewDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ comments: body.comments, general: typeof body.general === "string" ? body.general : "", savedAt: new Date().toISOString() }, null, 2));
        return json(res, 200, { ok: true });
      }
    }
    if (rest === "api/submit" && req.method === "POST") {
      if (!full) return json(res, 403, { ok: false, message: "这是只读链接，不能提交" });
      const body = (await readBody(req)) as { action?: string; comments?: ReviewComment[]; general?: string } | null;
      const action = body?.action;
      if (action !== "approve" && action !== "changes") return json(res, 400, { ok: false, message: "action 只能是 approve 或 changes" });
      const comments = Array.isArray(body?.comments) ? body.comments : [];
      if (action === "changes" && comments.length === 0 && !body?.general?.trim()) return json(res, 400, { ok: false, message: "还没有写任何意见" });
      const result =
        action === "approve" ? run("approve", entry.repo, entry.featureDir, []) : run("reply", entry.repo, entry.featureDir, [composeFeedback(comments, body?.general)]);
      fs.mkdirSync(path.join(reviewDir, "submitted"), { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.writeFileSync(path.join(reviewDir, "submitted", `${stamp}-${action}.json`), JSON.stringify({ action, comments, general: body?.general ?? "", result, versions: dirHash(prototypeDir) }, null, 2));
      if (result.ok) fs.rmSync(path.join(reviewDir, "draft.json"), { force: true });
      return json(res, result.ok ? 200 : 409, result);
    }
    return send(res, 404, "没有这个页面");
  }

  // 1.14: the code review page, /r/<token>/f/<key>/code/…
  async function handleCodeReview(req: http.IncomingMessage, res: http.ServerResponse, rest: string, entry: { repo: string; featureDir: string }, featureAbs: string, full: boolean) {
    const draftFile = path.join(featureAbs, ".pipeline", "code-review", "draft.json");
    if (rest === "") return sendFile(res, path.join(ASSETS, "code.html"));
    if (rest === "code.js" || rest === "code.css" || SHARED_ASSETS.has(rest)) return sendFile(res, path.join(ASSETS, rest));
    if (rest === "api/info" && req.method === "GET") {
      let draft: unknown = null;
      try {
        draft = JSON.parse(fs.readFileSync(draftFile, "utf8"));
      } catch {
        draft = null;
      }
      return json(res, 200, { ...buildCodeReview(entry.repo, entry.featureDir), readOnly: !full, draft });
    }
    if (rest === "api/draft" && req.method === "PUT") {
      if (!full) return json(res, 403, { ok: false, message: "这是只读链接" });
      const body = await readBody(req);
      if (!body || typeof body !== "object") return json(res, 400, { ok: false, message: "格式不对" });
      fs.mkdirSync(path.dirname(draftFile), { recursive: true });
      fs.writeFileSync(draftFile, JSON.stringify({ ...(body as object), savedAt: new Date().toISOString() }, null, 2));
      return json(res, 200, { ok: true });
    }
    if (rest === "api/submit" && req.method === "POST") {
      if (!full) return json(res, 403, { ok: false, message: "这是只读链接，不能提交" });
      const body = (await readBody(req)) as Partial<Submission> | null;
      const verdict = body?.verdict === "approve" ? "approve" : body?.verdict === "changes" ? "changes" : null;
      if (!verdict) return json(res, 400, { ok: false, message: "请选择评审通过或退回修改" });
      const data = buildCodeReview(entry.repo, entry.featureDir);
      if (data.running) return json(res, 409, { ok: false, message: "流水线正在运行，等它结束后再提交评审。" });
      const sub: Submission = {
        verdict,
        reviewer: typeof body?.reviewer === "string" ? body.reviewer : "",
        reviewers: Array.isArray(body?.reviewers) ? body.reviewers.filter((r): r is string => typeof r === "string") : [],
        comments: (Array.isArray(body?.comments) ? body.comments : []).filter((c) => c && typeof c.text === "string").map((c) => ({ file: typeof c.file === "string" ? c.file : null, line: typeof c.line === "number" ? c.line : null, text: c.text })),
        fix: (Array.isArray(body?.fix) ? body.fix : []).filter((f) => f && typeof f.id === "string").map((f) => ({ id: f.id, note: typeof f.note === "string" ? f.note : undefined })),
        note: typeof body?.note === "string" ? body.note : "",
      };
      if (verdict === "changes" && sub.comments.length === 0 && sub.fix.length === 0 && !sub.note.trim()) {
        return json(res, 400, { ok: false, message: "退回修改需要至少一条意见：在代码行上写意见，或把 AI 的意见标为\"要改\"。" });
      }
      const { review, committed } = recordHumanReview(entry.repo, entry.featureDir, sub);
      if (verdict === "approve") {
        return json(res, 200, { ok: true, verdict, committed, message: `已记录：评审通过${committed ? "，已写入 code-review.md 并提交" : ""}。${review.reviewers.length ? `审核人：${review.reviewers.join("、")}。` : ""}合并请求接入后会用这些审核人。` });
      }
      const started = codeFixRun(entry.repo, entry.featureDir);
      return json(res, 200, {
        ok: true,
        verdict,
        committed,
        message: started.ok
          ? `已记录 ${review.items.length} 条修改意见，流水线开始按意见修改（需求说明不变，从方案设计开始只处理这些意见），进展会发回需求的对话。`
          : `已记录 ${review.items.length} 条修改意见，但没能开始修改：${started.message.split("\n")[0]}。可以在需求的对话里说"按代码评审意见修改"，或执行 req review-fix ${path.basename(entry.featureDir)}。`,
      });
    }
    return send(res, 404, "没有这个页面");
  }

  // 1.14: the acceptance checklist, /r/<token>/f/<key>/check/…
  async function handleChecklist(req: http.IncomingMessage, res: http.ServerResponse, rest: string, entry: { repo: string; featureDir: string; key: string; project: string }, featureAbs: string, full: boolean) {
    const checkDir = path.join(featureAbs, ".pipeline", "check");
    if (rest === "") return sendFile(res, path.join(ASSETS, "check.html"));
    if (rest === "check.js" || rest === "check.css" || SHARED_ASSETS.has(rest)) return sendFile(res, path.join(ASSETS, rest));
    if (rest === "api/info" && req.method === "GET") {
      const state = readState(statePath(entry.repo, entry.featureDir));
      let draft: unknown = { answers: [], reviewer: "" };
      try {
        draft = JSON.parse(fs.readFileSync(path.join(checkDir, "draft.json"), "utf8"));
      } catch {
        /* none yet */
      }
      const acceptance = fs.existsSync(path.join(featureAbs, "acceptance.md")) ? fs.readFileSync(path.join(featureAbs, "acceptance.md"), "utf8") : "";
      return json(res, 200, {
        ...buildChecklist(featureAbs),
        project: entry.project,
        featureDir: entry.featureDir,
        readOnly: !full,
        running: state?.status === "running",
        accepted: /^[-*]\s*验收结论[:：]\s*(.+)$/m.exec(acceptance)?.[1]?.trim() ?? null,
        draft,
      });
    }
    if (rest === "api/draft" && req.method === "PUT") {
      if (!full) return json(res, 403, { ok: false, message: "这是只读链接" });
      const body = (await readBody(req)) as { answers?: unknown; reviewer?: unknown } | null;
      if (!body || !Array.isArray(body.answers)) return json(res, 400, { ok: false, message: "格式不对" });
      fs.mkdirSync(checkDir, { recursive: true });
      fs.writeFileSync(path.join(checkDir, "draft.json"), JSON.stringify({ answers: body.answers, reviewer: typeof body.reviewer === "string" ? body.reviewer : "", savedAt: new Date().toISOString() }, null, 2));
      return json(res, 200, { ok: true });
    }
    if (rest === "api/try" && req.method === "POST") {
      if (!full) return json(res, 403, { ok: false, message: "这是只读链接" });
      const body = (await readBody(req)) as { stop?: boolean } | null;
      return json(res, 200, tryRun(entry.repo, entry.featureDir, body?.stop === true));
    }
    if (rest === "api/submit" && req.method === "POST") {
      if (!full) return json(res, 403, { ok: false, message: "这是只读链接，不能提交" });
      const body = (await readBody(req)) as { answers?: Answer[]; reviewer?: string } | null;
      const answers = (Array.isArray(body?.answers) ? body.answers : []).filter((a) => a && typeof a.id === "string" && ["pass", "fail", "skip"].includes(a.mark));
      const list = buildChecklist(featureAbs);
      const v = verdictOf(list, answers);
      if (v.verdict === "通过" && v.missing.length > 0) {
        return json(res, 400, { ok: false, message: `还有 ${v.missing.length} 条必须验的没有核对（${v.missing.map((i) => i.id).join("、")}）。核对完，或者有不对的标"不对"后再提交。` });
      }
      const file = path.join(featureAbs, "acceptance.md");
      const previous = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
      const reviewer = body?.reviewer?.trim() || "需求方（验收页）";
      const text = acceptanceText(list, answers, { verdict: v.verdict, reviewer: reviewer.slice(0, 60), date: new Date().toISOString().slice(0, 10), previous });
      const { committed } = recordAcceptance(entry.repo, entry.featureDir, text);
      fs.rmSync(path.join(checkDir, "draft.json"), { force: true });
      // 1.14: the acceptance also goes into the usage records, for req stats.
      const marks = new Map(answers.map((a) => [a.id, a.mark]));
      appendEvent({
        kind: "acceptance",
        requirement: requirementRef(entry.repo, entry.featureDir),
        acceptance: {
          verdict: v.verdict,
          reviewer: reviewer.slice(0, 60),
          total: list.items.length,
          passed: list.items.filter((i) => marks.get(i.id) === "pass").length,
          failed: list.items.filter((i) => marks.get(i.id) === "fail").length,
          unchecked: list.items.filter((i) => !marks.get(i.id) || marks.get(i.id) === "skip").length,
        },
      });
      if (v.verdict === "通过") {
        return json(res, 200, { ok: true, verdict: v.verdict, committed, message: `已记录：验收通过${committed ? "，验收记录已提交" : ""}。下一步请开发同事审阅代码并合并。` });
      }
      const told = run("reply", entry.repo, entry.featureDir, ["--acceptance", acceptanceFailMessage(entry.featureDir, list, answers)]);
      return json(res, 200, {
        ok: true,
        verdict: v.verdict,
        committed,
        message: told.ok ? "已记录：验收不通过。不对的地方已经转给这个需求的对话，它会和你确定怎么处理。" : `已记录：验收不通过，但没能转给需求的对话（${told.message.split("\n")[0]}）。请在需求的对话里说"验收不通过"。`,
      });
    }
    return send(res, 404, "没有这个页面");
  }
}

// ---------------------------------------------------------------------------
// One server per machine

export interface ServerInfo {
  pid: number;
  port: number;
  token: string;
  readToken: string;
  version: string;
  publicUrl: string;
  startedAt: string;
}

export const infoFile = (env: NodeJS.ProcessEnv = process.env) => path.join(kitHome(env), "review-server.json");

function readInfo(env: NodeJS.ProcessEnv): ServerInfo | null {
  try {
    return JSON.parse(fs.readFileSync(infoFile(env), "utf8")) as ServerInfo;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function healthy(info: ServerInfo): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/r/${info.token}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok && ((await r.json()) as { version?: string }).version === kitVersion();
  } catch {
    return false;
  }
}

/** The running review server, started in the background when there is none (or an older one). */
export async function ensureReviewServer(env: NodeJS.ProcessEnv = process.env): Promise<ServerInfo> {
  const existing = readInfo(env);
  if (existing && alive(existing.pid) && (await healthy(existing))) return existing;
  if (existing && alive(existing.pid)) {
    try {
      process.kill(existing.pid);
    } catch {
      /* gone */
    }
  }
  fs.mkdirSync(kitHome(env), { recursive: true });
  const log = fs.openSync(path.join(kitHome(env), "review-server.log"), "a");
  const child = spawn(process.execPath, [...process.execArgv, path.join(ENGINE_DIR, "src", "review.ts"), "--serve"], {
    detached: true,
    stdio: ["ignore", log, log],
    env,
    windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const info = readInfo(env);
    if (info && info.pid === child.pid && (await healthy(info))) return info;
  }
  throw new Error(`原型审查页没有启动，日志：${path.join(kitHome(env), "review-server.log")}`);
}

/** The page of one requirement (by its key in the requirement index). */
export function reviewUrl(info: ServerInfo, key: string, readOnly = false): string {
  return `${info.publicUrl.replace(/\/+$/, "")}/r/${readOnly ? info.readToken : info.token}/f/${encodeURIComponent(key)}/`;
}

/** Finds the index key of a requirement from its repository and feature directory. */
export function keyOf(repo: string, featureDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const norm = (p: string) => path.resolve(p).toLowerCase();
  const dir = norm(path.join(repo, featureDir));
  const e = readIndex(env).find((x) => norm(path.join(x.repo, x.featureDir)) === dir || (x.sourceRepo !== null && norm(path.join(x.sourceRepo, x.featureDir)) === dir));
  return e?.key ?? null;
}

async function serve(env: NodeJS.ProcessEnv): Promise<void> {
  const token = crypto.randomBytes(18).toString("base64url");
  const readToken = crypto.randomBytes(18).toString("base64url");
  let last = Date.now();
  const server = createReviewServer({ token, readToken, env, onRequest: () => (last = Date.now()) });
  const host = env.REQ_KIT_REVIEW_HOST?.trim() || "127.0.0.1";
  const wanted = Number(env.REQ_KIT_REVIEW_PORT ?? DEFAULT_PORT);
  const listen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve((server.address() as { port: number }).port);
      });
    });
  let port: number;
  try {
    port = await listen(wanted);
  } catch {
    port = await listen(0);
  }
  const info: ServerInfo = {
    pid: process.pid,
    port,
    token,
    readToken,
    version: kitVersion(),
    // Listening for other computers without a public address: this computer's name is the best guess.
    publicUrl: env.REQ_KIT_REVIEW_PUBLIC_URL?.trim() || `http://${/^(127\.|localhost$|::1$)/.test(host) ? "127.0.0.1" : os.hostname()}:${port}`,
    startedAt: new Date().toISOString(),
  };
  fs.mkdirSync(kitHome(env), { recursive: true });
  fs.writeFileSync(infoFile(env), JSON.stringify(info, null, 2), { mode: 0o600 });
  console.log(`[${info.startedAt}] 原型审查页在 ${host}:${port} 运行（req-kit ${info.version}）`);
  const timer = setInterval(() => {
    if (Date.now() - last < IDLE_EXIT_MS) return;
    clearInterval(timer);
    const current = readInfo(env);
    if (current?.pid === process.pid) fs.rmSync(infoFile(env), { force: true });
    server.close(() => process.exit(0));
  }, 60_000);
}

// ---------------------------------------------------------------------------
// req review <需求> [--no-open] [--read-only]

export function openBrowser(url: string) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* the address is printed anyway */
  }
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "--serve") {
    await serve(process.env);
    return -1;
  }
  const open = !argv.includes("--no-open");
  const readOnly = argv.includes("--read-only");
  // 1.14: --page code opens the code review page of the same server.
  const pageAt = argv.indexOf("--page");
  const page = pageAt >= 0 ? argv[pageAt + 1] : null;
  const feature = argv.find((a, i) => !a.startsWith("--") && !(pageAt >= 0 && i === pageAt + 1));
  if (page === "code" && feature && !argv.includes("--help")) {
    const { locate } = await import("./api.js");
    const { repo, featureDir } = locate(process.cwd(), feature);
    const key = keyOf(repo, featureDir);
    if (!key) {
      console.error(`${featureDir} 不在本机的需求列表中，先运行一次 req index --rebuild`);
      return 1;
    }
    const url = `${reviewUrl(await ensureReviewServer(), key, readOnly)}code/`;
    console.log(`代码审查页：${url}`);
    if (open) openBrowser(url);
    return 0;
  }
  if (!feature || argv.includes("--help") || argv.includes("-h")) {
    console.log("用法：req review <需求> [--no-open] [--read-only]\n\n在浏览器中打开这个需求的原型审查页：点选要改的地方、直接改文字，然后提交修改意见或确认方案。");
    return feature ? 0 : 2;
  }
  const { locate } = await import("./api.js");
  const { repo, featureDir } = locate(process.cwd(), feature);
  if (!fs.existsSync(path.join(repo, featureDir, "prototype"))) {
    console.error(`${featureDir} 还没有界面原型（prototype/）。界面改动的需求在方案设计后才会有。`);
    return 1;
  }
  const key = keyOf(repo, featureDir);
  if (!key) {
    console.error(`${featureDir} 不在本机的需求列表中，先运行一次 req index --rebuild`);
    return 1;
  }
  const url = reviewUrl(await ensureReviewServer(), key, readOnly);
  console.log(`原型审查页：${url}`);
  if (open) openBrowser(url);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code >= 0) process.exit(code);
    },
    (error: Error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
