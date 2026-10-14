import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkApplies, logName, matchesPath, runCheck, tail } from "../src/gate.js";

test("路径匹配：目录前缀、单个文件、通配符", () => {
  assert.ok(matchesPath("web/src/app.ts", "web/"));
  assert.ok(matchesPath("web/src/app.ts", "web"));
  assert.ok(!matchesPath("webapp/x.ts", "web"));
  assert.ok(matchesPath("src/pages/login.tsx", "src/pages/login.tsx"));
  assert.ok(matchesPath("src/a/b/c.test.ts", "src/**/*.test.ts"));
  assert.ok(!matchesPath("src/a/b/c.ts", "src/**/*.test.ts"));
  assert.ok(matchesPath("config/app.json", "./config/*.json"));
  assert.ok(matchesPath("anything", "."));
});

test("检查是否适用：只看它关心的路径；不知道改了什么时一律运行", () => {
  const web = { name: "web", command: "npm test", cwd: "web" };
  const all = { name: "all", command: "npm test" };
  const listed = { name: "api", command: "npm test", paths: ["server/", "shared/"] };
  assert.ok(checkApplies(web, ["web/a.ts"]));
  assert.ok(!checkApplies(web, ["server/a.ts"]));
  assert.ok(checkApplies(web, null));
  assert.ok(checkApplies(all, ["README.md"]));
  assert.ok(checkApplies(listed, ["shared/types.ts"]));
  assert.ok(!checkApplies(listed, ["web/a.ts"]));
});

test("运行检查：退出码判定结果，输出保留；超时会停止；目录不存在时判为失败", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "req-gate-"));
  fs.mkdirSync(path.join(repo, "web"));
  const ok = await runCheck({ name: "ok", command: "node -e \"console.log('fine')\"", cwd: "web" }, repo, 1);
  assert.equal(ok.outcome, "pass");
  assert.match(ok.output, /fine/);
  const failed = await runCheck({ name: "bad", command: "node -e \"console.error('boom'); process.exit(3)\"" }, repo, 1);
  assert.equal(failed.outcome, "fail");
  assert.equal(failed.exitCode, 3);
  assert.match(failed.output, /boom/);
  const slow = await runCheck({ name: "slow", command: "node -e \"setTimeout(() => {}, 60000)\"", timeoutMinutes: 0.01 }, repo, 1);
  assert.equal(slow.outcome, "fail");
  assert.ok(slow.timedOut);
  const missing = await runCheck({ name: "m", command: "npm test", cwd: "nope" }, repo, 1);
  assert.equal(missing.outcome, "fail");
  assert.match(missing.output, /检查的目录不存在/);
});

test("输出截取最后几行；日志文件名去掉特殊字符", () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const last = tail(text, 3).split("\n");
  assert.deepEqual(last, ["…", "line 97", "line 98", "line 99"]);
  assert.equal(logName("web 测试/单元"), "web-测试-单元.log");
});
