// paseo.json checks shared by the doctor.
//
// Paseo 0.11 runs project commands with a different shell on each system:
//   worktree.setup: bash (macOS, Linux) / powershell -ExecutionPolicy Bypass (Windows)
//   scripts:        the terminal's shell, $SHELL or /bin/sh (macOS, Linux) / cmd.exe (Windows)
// paseo.json is committed and shared, so commands should work in all of them: plain program
// invocations, with environment variables read by the program (see /req-setup's helpers).

export type PaseoJson = { worktree?: { setup?: unknown }; scripts?: Record<string, { type?: string; command?: string; port?: number }> };

export type ShellStyle = "posix" | "powershell" | "cmd";

const STYLE_NAMES: Record<ShellStyle, string> = { posix: "bash/sh", powershell: "PowerShell", cmd: "cmd.exe" };

/** Shell-specific syntax found in a command (empty: works the same everywhere). */
export function shellStyles(command: string): ShellStyle[] {
  const styles = new Set<ShellStyle>();
  if (/\$env:[A-Za-z_]/i.test(command) || /\b(Test-Path|Copy-Item|Set-Location|Get-ChildItem|Remove-Item)\b/.test(command)) styles.add("powershell");
  if (/%[A-Za-z_][A-Za-z0-9_]*%/.test(command)) styles.add("cmd");
  if (/(^|[^:\w`])\$\{?(?!env:)[A-Za-z_]/i.test(command) || /\[\s+-[a-z]\s/.test(command) || /(^|\s)(cp|mv|rm|export)\s/.test(command) || /\|\||&&/.test(command)) {
    // `&&` works in cmd and PowerShell 7 too, but not in Windows PowerShell 5.1, which Paseo uses for setup.
    styles.add("posix");
  }
  return [...styles];
}

function setupCommands(raw: PaseoJson): string[] {
  const setup = raw.worktree?.setup;
  if (Array.isArray(setup)) return setup.map(String);
  return typeof setup === "string" ? setup.split(/\r?\n/).filter((l) => l.trim()) : [];
}

export interface PaseoJsonIssue {
  /** "fails": the command will not work on this machine; "portable": it only works on some systems. */
  kind: "fails" | "portable";
  text: string;
  fix: string;
}

const FIX =
  "改成各系统都一样的写法：准备命令用 node scripts/paseo/copy-local-files.mjs .env，服务用 node scripts/paseo/with-port.mjs npm run dev -- --port {PORT}（/req-setup 会写入这两个脚本）";

/** Problems of the project's paseo.json for the system Paseo runs on (process.platform by default). */
export function paseoJsonIssues(raw: PaseoJson, platform: NodeJS.Platform = process.platform): PaseoJsonIssue[] {
  const windows = platform === "win32";
  const setupShell: ShellStyle = windows ? "powershell" : "posix";
  const scriptShell: ShellStyle = windows ? "cmd" : "posix";
  const issues: PaseoJsonIssue[] = [];
  const check = (where: string, command: string, shell: ShellStyle) => {
    const styles = shellStyles(command);
    if (styles.length === 0) return;
    const short = command.length > 60 ? `${command.slice(0, 60)}…` : command;
    const foreign = styles.filter((s) => s !== shell);
    if (foreign.length > 0) {
      issues.push({
        kind: "fails",
        text: `${where}「${short}」是 ${foreign.map((s) => STYLE_NAMES[s]).join("、")} 写法，这台机器上 Paseo 用 ${STYLE_NAMES[shell]} 执行，会失败`,
        fix: FIX,
      });
    } else {
      issues.push({
        kind: "portable",
        text: `${where}「${short}」用了 ${STYLE_NAMES[shell]} 的写法，在这台机器上可以用，换到其他系统（Windows 和 macOS/Linux 之间）会失败`,
        fix: FIX,
      });
    }
  };
  for (const cmd of setupCommands(raw)) check("paseo.json 的 worktree.setup 中", cmd, setupShell);
  for (const [name, s] of Object.entries(raw.scripts ?? {})) {
    check(`paseo.json 的${s.type === "service" ? "服务" : "脚本"} ${name}`, String(s.command ?? ""), scriptShell);
  }
  return issues;
}
