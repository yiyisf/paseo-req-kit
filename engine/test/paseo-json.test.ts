import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { paseoJsonIssues, shellStyles } from "../src/paseo-json.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const HELPERS = path.join(ROOT, "skills", "req-setup", "templates", "paseo");

const POSIX = {
  worktree: { setup: ["npm ci", '[ -f "$PASEO_SOURCE_CHECKOUT_PATH/.env" ] && cp "$PASEO_SOURCE_CHECKOUT_PATH/.env" .env'] },
  scripts: { web: { type: "service", command: "npm run dev -- --port $PASEO_PORT" }, test: { command: "npm test" } },
};
const WINDOWS = {
  worktree: { setup: ['if (Test-Path "$env:PASEO_SOURCE_CHECKOUT_PATH\\.env") { Copy-Item "$env:PASEO_SOURCE_CHECKOUT_PATH\\.env" .env }'] },
  scripts: { web: { type: "service", command: "npm run dev -- --port %PASEO_PORT%" } },
};
const PORTABLE = {
  worktree: { setup: ["npm ci", "node scripts/paseo/copy-local-files.mjs .env"] },
  scripts: { web: { type: "service", command: "node scripts/paseo/with-port.mjs npm run dev -- --port {PORT}" }, test: { command: "npm test" } },
};

test("命令的 shell 写法识别", () => {
  assert.deepEqual(shellStyles("npm ci"), []);
  assert.deepEqual(shellStyles("node scripts/paseo/with-port.mjs npm run dev -- --port {PORT}"), []);
  assert.deepEqual(shellStyles("npm run dev -- --port $PASEO_PORT"), ["posix"]);
  assert.deepEqual(shellStyles("npm run dev -- --port %PASEO_PORT%"), ["cmd"]);
  assert.deepEqual(shellStyles('Copy-Item "$env:X\\.env" .env'), ["powershell"]);
});

test("paseo.json 体检：按 Paseo 在各系统用的 shell 判断，各系统通用的写法没有问题", () => {
  // bash-style on Windows fails; on macOS/Linux it works but is not portable.
  const onWindows = paseoJsonIssues(POSIX, "win32");
  assert.equal(onWindows.filter((i) => i.kind === "fails").length, 2);
  assert.match(onWindows[0].text, /PowerShell 执行，会失败/);
  assert.match(onWindows[1].text, /服务 web.*cmd\.exe 执行，会失败/);
  assert.ok(paseoJsonIssues(POSIX, "linux").every((i) => i.kind === "portable"));
  // Windows-style on macOS fails, on Windows it is not portable.
  assert.equal(paseoJsonIssues(WINDOWS, "darwin").filter((i) => i.kind === "fails").length, 2);
  assert.ok(paseoJsonIssues(WINDOWS, "win32").every((i) => i.kind === "portable"));
  for (const platform of ["win32", "darwin", "linux"] as const) assert.deepEqual(paseoJsonIssues(PORTABLE, platform), []);
});

test("/req-setup 的辅助脚本：with-port 替换端口并设置 PORT；copy-local-files 复制存在的本地文件、跳过已有的", () => {
  const ran = spawnSync(process.execPath, [path.join(HELPERS, "with-port.mjs"), process.execPath, "-e", "console.log(process.argv[1], process.env.PORT)", "{PORT}"], {
    encoding: "utf8",
    env: { ...process.env, PASEO_PORT: "4123" },
  });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout.trim(), "4123 4123");
  const missing = spawnSync(process.execPath, [path.join(HELPERS, "with-port.mjs"), "echo", "{PORT}"], {
    encoding: "utf8",
    env: { ...process.env, PASEO_PORT: "", PORT: "" },
  });
  assert.equal(missing.status, 2);

  const source = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-source-"));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-target-"));
  fs.writeFileSync(path.join(source, ".env"), "A=1\n");
  fs.mkdirSync(path.join(source, "config"));
  fs.writeFileSync(path.join(source, "config", "local.json"), "{}");
  fs.writeFileSync(path.join(target, "keep.txt"), "mine");
  fs.writeFileSync(path.join(source, "keep.txt"), "theirs");
  const copy = spawnSync(process.execPath, [path.join(HELPERS, "copy-local-files.mjs"), ".env", "config/local.json", "keep.txt", "absent.txt"], {
    cwd: target,
    encoding: "utf8",
    env: { ...process.env, PASEO_SOURCE_CHECKOUT_PATH: source },
  });
  assert.equal(copy.status, 0, copy.stderr);
  assert.equal(fs.readFileSync(path.join(target, ".env"), "utf8"), "A=1\n");
  assert.ok(fs.existsSync(path.join(target, "config", "local.json")));
  assert.equal(fs.readFileSync(path.join(target, "keep.txt"), "utf8"), "mine");
  const outside = spawnSync(process.execPath, [path.join(HELPERS, "copy-local-files.mjs"), ".env"], { cwd: target, encoding: "utf8", env: { ...process.env, PASEO_SOURCE_CHECKOUT_PATH: "" } });
  assert.equal(outside.status, 0);
});
