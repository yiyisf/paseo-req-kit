import assert from "node:assert/strict";
import { test } from "node:test";
import { windowsPaseoJsonIssues } from "../src/paseo-json.js";

test("Windows 上的 paseo.json：指出 bash 写法的准备命令和用了 $变量的脚本", () => {
  const bash = windowsPaseoJsonIssues({
    worktree: { setup: ["npm ci", '[ -f "$PASEO_SOURCE_CHECKOUT_PATH/.env" ] && cp "$PASEO_SOURCE_CHECKOUT_PATH/.env" .env'] },
    scripts: { web: { type: "service", command: "npm run dev -- --port $PASEO_PORT" }, test: { command: "npm test" } },
  });
  assert.equal(bash.length, 2);
  assert.match(bash[0].text, /worktree\.setup.*PowerShell/);
  assert.match(bash[1].text, /服务 web.*cmd\.exe/);
  assert.match(bash[1].fix, /%PASEO_PORT%/);

  const windows = windowsPaseoJsonIssues({
    worktree: { setup: ["npm ci", 'if (Test-Path "$env:PASEO_SOURCE_CHECKOUT_PATH\\.env") { Copy-Item "$env:PASEO_SOURCE_CHECKOUT_PATH\\.env" .env }'] },
    scripts: { web: { type: "service", command: "npm run dev -- --port %PASEO_PORT%" } },
  });
  assert.deepEqual(windows, []);
});
