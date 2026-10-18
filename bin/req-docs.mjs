#!/usr/bin/env node
// `req docs` (1.13): serves this version's documentation site on this machine and opens it in
// the browser. The release builds the site into the package (site-dist/), so it matches the
// installed version and needs no internet (e.g. inside a company network with only an npm
// mirror). A development clone uses site/.vitepress/dist after `npm run build` in site/.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 6780;
const ONLINE = "https://paseo-req-kit.vercel.app/";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".ps1": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};

const HELP = `用法：req docs [--port <端口>] [--no-open]

在本机打开这个版本的 req-kit 文档站点（不需要外网）。按 Ctrl+C 停止。
  --port <端口>  使用这个端口（默认 ${DEFAULT_PORT}，被占用时换一个空闲的）
  --no-open      不打开浏览器，只显示地址`;

/** The built site: in the package, or in a development clone after building it. */
export function siteDir(root = KIT_ROOT, env = process.env) {
  const candidates = [env.REQ_KIT_DOCS_DIR?.trim(), path.join(root, "site-dist"), path.join(root, "site", ".vitepress", "dist")].filter(Boolean);
  return candidates.find((d) => fs.existsSync(path.join(d, "index.html"))) ?? null;
}

/** The file for a request path: the file itself, <path>.html (clean URLs) or <path>/index.html. */
export function resolveFile(dir, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split(/[?#]/)[0]);
  } catch {
    return null;
  }
  const base = path.resolve(dir);
  const target = path.resolve(base, `.${path.posix.normalize(`/${rel}`)}`);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  for (const file of [target, `${target}.html`, path.join(target, "index.html")]) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      /* next */
    }
  }
  return null;
}

export function createServer(dir) {
  return http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    let file = resolveFile(dir, req.url ?? "/");
    let status = 200;
    if (!file) {
      status = 404;
      file = resolveFile(dir, "/404.html");
    }
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("没有这个页面");
      return;
    }
    res.writeHead(status, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache" });
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(file).pipe(res);
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server.address().port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* the address is printed anyway */
  }
}

async function main(argv) {
  let port = DEFAULT_PORT;
  let fixedPort = false;
  let open = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a.startsWith("--port=")) {
      const v = a.includes("=") ? a.slice(7) : argv[++i];
      port = Number(v);
      fixedPort = true;
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error(`--port 要写端口号，例如 --port ${DEFAULT_PORT}`);
        return 2;
      }
    } else if (a === "--no-open") open = false;
    else if (a === "-h" || a === "--help") {
      console.log(HELP);
      return 0;
    } else {
      console.error(`不认识的选项：${a}\n\n${HELP}`);
      return 2;
    }
  }
  const dir = siteDir();
  if (!dir) {
    console.error(
      `这个 req-kit 副本没有内置文档站点（${KIT_ROOT}）。\n` +
        `  · 从 npm 安装的 1.13 及以后的版本都带有文档：req upgrade\n` +
        `  · 开发用的副本：在 site/ 中运行 npm install && npm run build\n` +
        `  · 文档原文在 ${path.join(KIT_ROOT, "docs", "guide")}，能上外网时也可以打开 ${ONLINE}`,
    );
    return 1;
  }
  const server = createServer(dir);
  let actual;
  try {
    actual = await listen(server, port);
  } catch (error) {
    if (fixedPort || error?.code !== "EADDRINUSE") {
      console.error(`没能在端口 ${port} 上启动：${error.message}`);
      return 1;
    }
    actual = await listen(server, 0);
  }
  const url = `http://127.0.0.1:${actual}/`;
  console.log(`req-kit 文档：${url}（按 Ctrl+C 停止）`);
  if (open) openBrowser(url);
  await new Promise(() => {});
  return 0;
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) main(process.argv.slice(2)).then((code) => process.exit(code));
