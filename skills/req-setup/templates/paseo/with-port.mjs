#!/usr/bin/env node
// Written into the project by req-kit's /req-setup. Runs a command with {PORT} replaced by
// the port Paseo assigned (PASEO_PORT), the same way on macOS, Linux and Windows, whatever
// shell Paseo uses there (bash, sh, cmd.exe). Also sets PORT for programs that read it.
//
//   paseo.json: "command": "node scripts/paseo/with-port.mjs npm run dev -- --port {PORT}"
//   by hand:    PASEO_PORT=4100 node scripts/paseo/with-port.mjs npm run dev -- --port {PORT}

import { spawn } from "node:child_process";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("用法：node scripts/paseo/with-port.mjs <命令> [参数…]（参数中的 {PORT} 换成环境变量 PASEO_PORT）");
  process.exit(2);
}
const port = process.env.PASEO_PORT ?? process.env.PORT;
if (!port && args.some((a) => a.includes("{PORT}"))) {
  console.error("没有环境变量 PASEO_PORT：它由 Paseo 提供，手工运行时请自己设置。");
  process.exit(2);
}
const resolved = args.map((a) => (port ? a.replaceAll("{PORT}", port) : a));
// npm, npx and other .cmd shims need a shell on Windows.
const windows = process.platform === "win32";
const child = spawn(resolved[0], resolved.slice(1).map((a) => (windows && /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)), {
  stdio: "inherit",
  shell: windows,
  env: port ? { ...process.env, PORT: port } : process.env,
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(`无法启动 ${resolved[0]}：${error.message}`);
  process.exit(127);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
