// req docs (1.13): the documentation site served from the package.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveFile, siteDir } from "../bin/req-docs.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

function site(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-site-"));
  fs.mkdirSync(path.join(dir, "guide"), { recursive: true });
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>home</h1>");
  fs.writeFileSync(path.join(dir, "guide", "getting-started.html"), "<h1>start</h1>");
  fs.writeFileSync(path.join(dir, "guide", "index.html"), "<h1>guide</h1>");
  fs.writeFileSync(path.join(dir, "404.html"), "<h1>not found</h1>");
  fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");
  return dir;
}

test("req docs：按干净地址找文件，不能跳出站点目录；找站点时先看包里的 site-dist", () => {
  const dir = site();
  assert.equal(resolveFile(dir, "/"), path.join(dir, "index.html"));
  assert.equal(resolveFile(dir, "/guide/getting-started"), path.join(dir, "guide", "getting-started.html"));
  assert.equal(resolveFile(dir, "/guide/getting-started.html?x=1#top"), path.join(dir, "guide", "getting-started.html"));
  assert.equal(resolveFile(dir, "/guide/"), path.join(dir, "guide", "index.html"));
  assert.equal(resolveFile(dir, "/nothing"), null);
  assert.equal(resolveFile(dir, "/../../etc/passwd"), null);
  assert.equal(resolveFile(dir, "/%2e%2e/%2e%2e/etc/passwd"), null);
  assert.equal(resolveFile(dir, "/%E0%A4%A"), null);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-root-"));
  assert.equal(siteDir(root, {}), null);
  fs.cpSync(dir, path.join(root, "site", ".vitepress", "dist"), { recursive: true });
  assert.equal(siteDir(root, {}), path.join(root, "site", ".vitepress", "dist"));
  fs.cpSync(dir, path.join(root, "site-dist"), { recursive: true });
  assert.equal(siteDir(root, {}), path.join(root, "site-dist"));
});

test("req docs：在本机端口上提供站点，未知页面返回 404 页", async () => {
  const dir = site();
  // req-docs.mjs itself: `req docs` runs it in a child process, which a test could not stop.
  const child = spawn(process.execPath, [path.join(ROOT, "bin", "req-docs.mjs"), "--no-open", "--port", "0"], {
    env: { ...process.env, REQ_KIT_DOCS_DIR: dir },
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (d) => {
        out += d;
        const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
        if (m) resolve(m[1]);
      });
      child.on("exit", (code) => reject(new Error(`exited ${code}: ${out}`)));
    });
    const home = await fetch(url);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(await home.text(), "<h1>home</h1>");
    assert.equal(await (await fetch(`${url}guide/getting-started`)).text(), "<h1>start</h1>");
    const js = await fetch(`${url}assets/app.js`);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    const missing = await fetch(`${url}guide/nope`);
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), "<h1>not found</h1>");
  } finally {
    child.kill();
  }
  const help = spawnSync(process.execPath, [path.join(ROOT, "bin", "req.mjs"), "docs", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /在本机打开这个版本的 req-kit 文档站点/);
});
