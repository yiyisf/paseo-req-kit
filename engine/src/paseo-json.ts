// paseo.json checks shared by the doctor.

export type PaseoJson = { worktree?: { setup?: unknown }; scripts?: Record<string, { type?: string; command?: string; port?: number }> };

/**
 * Problems of a paseo.json on a Windows machine. Paseo 0.11 runs worktree.setup commands
 * in PowerShell (powershell -ExecutionPolicy Bypass -Command) and scripts/services in a
 * terminal whose shell is cmd.exe (ComSpec). Commands written for bash fail there.
 */
export function windowsPaseoJsonIssues(raw: PaseoJson): Array<{ text: string; fix: string }> {
  const issues: Array<{ text: string; fix: string }> = [];
  const setup = Array.isArray(raw.worktree?.setup) ? (raw.worktree?.setup as unknown[]) : raw.worktree?.setup ? [raw.worktree.setup] : [];
  for (const cmd of setup.map(String)) {
    const bashVar = /(^|[^:\w])\$(?!env:)[A-Za-z_]/.test(cmd);
    if (bashVar || /\[\s+-[a-z]\s/.test(cmd) || /&&|\|\|/.test(cmd)) {
      issues.push({
        text: `paseo.json 的 worktree.setup 中「${cmd.slice(0, 60)}」是 bash 写法；Windows 上 Paseo 用 PowerShell 执行准备命令，会失败`,
        fix: '改成 PowerShell 写法，例如 if (Test-Path "$env:PASEO_SOURCE_CHECKOUT_PATH\\.env") { Copy-Item "$env:PASEO_SOURCE_CHECKOUT_PATH\\.env" .env }；或改成 node 脚本',
      });
    }
  }
  for (const [name, s] of Object.entries(raw.scripts ?? {})) {
    if (/\$\{?[A-Za-z_]/.test(String(s.command ?? ""))) {
      issues.push({
        text: `paseo.json 中的${s.type === "service" ? "服务" : "脚本"} ${name} 用了 $变量；Windows 上 Paseo 在 cmd.exe 中运行脚本，$PASEO_PORT 这类变量不会被替换`,
        fix: "改成 cmd 写法 %PASEO_PORT%，或者让程序自己读取环境变量 PASEO_PORT（这样各个系统都能用）",
      });
    }
  }
  return issues;
}
