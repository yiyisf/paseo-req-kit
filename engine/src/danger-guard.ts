// Stopping dangerous commands (1.14): step agents usually run commands without asking (the
// provider's "no confirmation" mode), so the rules "only local commits, never touch production"
// were only words in the prompt. While a step runs, the pipeline looks at the commands the agent
// has run or is running (its Paseo timeline, every few seconds to a minute); a command that
// pushes, publishes, changes a cluster, connects to a remote database or host, deletes outside
// the repository, runs a downloaded script, or mentions a configured production address is
// interrupted (if still running) and reported to the person. A plain check of the command
// text, no model; it catches the common cases, it is not a sandbox.
import os from "node:os";
import path from "node:path";

export interface DangerGuardSettings {
  enabled: boolean;
  /** Text that marks a production system (host names, addresses, database names); any command containing it is stopped. */
  production: string[];
  /** Regular expressions of commands that are allowed after all (e.g. "^ssh test-box"). */
  allow: string[];
}

export interface ToolCall {
  callId: string;
  kind: string;
  text: string;
  status: string;
  startedAt: string;
}

export interface Danger {
  /** What kind of operation it is, for the person (e.g. "推送到远程仓库"). */
  label: string;
  /** Why it is not allowed in a pipeline step. */
  why: string;
}

const LOCAL_HOSTS = /^(localhost|127(\.\d+){3}|0\.0\.0\.0|::1|\[::1\]|host\.docker\.internal)$/i;

/** Splits a command line into simple commands (on ; && || | and newlines), each a list of words without quotes. */
export function segments(command: string): string[][] {
  const out: string[][] = [];
  for (const part of command.split(/\|\||&&|[;|\n]|\r/)) {
    const words = (part.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ""));
    // Wrappers that run the rest as a command.
    while (words.length && /^(sudo|env|nohup|time|exec|command|xargs|npx|cmd(\.exe)?|\/c|powershell(\.exe)?|pwsh|-Command|-c|bash|sh|zsh|-lc|-l)$/i.test(words[0])) words.shift();
    while (words.length && /^\w+=/.test(words[0])) words.shift();
    // A command given as one quoted argument (bash -lc "git push"): look inside it.
    if (words.length && /\s/.test(words[0])) out.push(...segments(words.join(" ")));
    else if (words.length) out.push(words);
  }
  return out;
}

const base = (w: string) => w.replace(/\\/g, "/").split("/").pop()!.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();

function hostOf(value: string): string {
  const v = value.replace(/^\w+:\/\//, "").replace(/^[^@/]*@/, "");
  return v.replace(/[:/].*$/, "");
}

/** A host that is clearly another machine: an address or a dotted name that is not this machine. Service names of docker compose ("db") count as local. */
function remoteHost(host: string): boolean {
  if (!host || LOCAL_HOSTS.test(host)) return false;
  return /\./.test(host) || /^\d+(\.\d+){3}$/.test(host);
}

function deletesOutside(words: string[], repo: string | null, home: string): string | null {
  const targets = words.slice(1).filter((w) => !w.startsWith("-") && !/^\/[a-z]$/i.test(w));
  const h = home.replace(/\\/g, "/").replace(/\/+$/, "");
  for (const raw of targets) {
    const t = raw.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
    if (/^(\/|\/\*|~|~\/\*|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE|[a-z]:|[a-z]:\/\*|\.\.(\/\.\.)*(\/\*)?|\*|\/\*\.\*)$/i.test(t)) return raw;
    if (t === h) return raw;
    if (/^(\/|[a-z]:\/)/i.test(t)) {
      const abs = path.resolve(t);
      const inside = (dir: string | null) => !!dir && (abs === path.resolve(dir) || abs.startsWith(path.resolve(dir) + path.sep));
      if (!inside(repo) && !inside(os.tmpdir()) && !/^\/(tmp|var\/tmp)(\/|$)/.test(t)) return raw;
    }
  }
  return null;
}

function judgeSegment(words: string[], repo: string | null, home: string): Danger | null {
  const cmd = base(words[0]);
  const rest = words.slice(1);
  const sub = rest.find((w) => !w.startsWith("-"))?.toLowerCase() ?? "";
  const has = (re: RegExp) => rest.some((w) => re.test(w));

  if (cmd === "git") {
    // Skip global options (-C dir, -c k=v) to find the git command.
    let i = 0;
    while (i < rest.length && rest[i].startsWith("-")) i += /^-[Cc]$/.test(rest[i]) ? 2 : 1;
    const g = rest[i]?.toLowerCase();
    const args = rest.slice(i + 1);
    if (g === "push") {
      const force = args.some((w) => /^(--force|--force-with-lease|-f|--mirror|--delete|-d)$/.test(w) || /^\+/.test(w) || /^--force-with-lease=/.test(w) || /^:/.test(w));
      return force
        ? { label: "强制推送或删除远程分支", why: "会改写或删除远程仓库的历史，别人的提交可能丢失" }
        : { label: "推送到远程仓库", why: "流水线只做本地提交，推送和合并由人决定（接单器模式由流水线自己推送需求分支）" };
    }
    if (g === "remote" && /^(add|set-url|remove|rm)$/.test(args[0] ?? "")) return { label: "修改远程仓库地址", why: "会改变代码推送到哪里" };
    return null;
  }
  if (cmd === "rm" && rest.some((w) => /^-[a-z]*r/i.test(w) || w === "--recursive")) {
    const t = deletesOutside(words, repo, home);
    if (t) return { label: `删除仓库以外的目录（${t}）`, why: "会删除仓库以外的文件，无法恢复" };
  }
  if (/^(remove-item|ri|rd|rmdir|del|erase)$/.test(cmd) && has(/^(-recurse|-r|\/s)$/i)) {
    const t = deletesOutside(words.filter((w) => !/^-(recurse|force|r)$/i.test(w) && !/^\/[sq]$/i.test(w)), repo, home);
    if (t) return { label: `删除仓库以外的目录（${t}）`, why: "会删除仓库以外的文件，无法恢复" };
  }
  if (/^(npm|pnpm|yarn|cargo|gem|twine|poetry|flit)$/.test(cmd) && (sub === "publish" || (sub === "npm" && rest[1] === "publish") || (cmd === "gem" && sub === "push") || (cmd === "twine" && sub === "upload")))
    return { label: "发布包到制品仓库", why: "发布出去的版本别人马上能用到，撤不回来" };
  if (/^(mvn|mvnw)$/.test(cmd) && has(/^(deploy|release:perform|deploy:deploy(-file)?)$/)) return { label: "发布制品（mvn deploy）", why: "发布出去的版本别人马上能用到，撤不回来" };
  if (/^(gradle|gradlew)$/.test(cmd) && has(/^(publish\w*|uploadArchives)$/)) return { label: "发布制品（gradle publish）", why: "发布出去的版本别人马上能用到，撤不回来" };
  if (cmd === "docker" && sub === "push") return { label: "推送镜像到镜像仓库", why: "镜像仓库是共享的，部署可能直接用到" };
  if (cmd === "docker" && sub === "login") return { label: "登录镜像仓库", why: "会在这台机器上保存镜像仓库的凭据" };
  if (cmd === "dotnet" && sub === "nuget" && rest[1] === "push") return { label: "发布包到制品仓库", why: "发布出去的版本别人马上能用到，撤不回来" };
  if (/^(kubectl|oc)$/.test(cmd) && /^(apply|create|delete|replace|patch|scale|rollout|edit|drain|cordon|exec|cp|set|label|annotate|run)$/.test(sub))
    return { label: "修改集群（kubectl）", why: "会改动共享的环境，流水线只在本地或测试环境验证" };
  if (cmd === "helm" && /^(install|upgrade|uninstall|delete|rollback)$/.test(sub)) return { label: "修改集群（helm）", why: "会改动共享的环境，流水线只在本地或测试环境验证" };
  if (cmd === "terraform" && /^(apply|destroy|import|taint)$/.test(sub)) return { label: "修改基础设施（terraform）", why: "会改动共享的环境，流水线只在本地或测试环境验证" };
  if (cmd === "ansible-playbook" || (cmd === "ansible" && !has(/^(--check|-C)$/))) return { label: "在服务器上执行（ansible）", why: "会改动其他机器" };
  if (/^(mysql|mysqldump|psql|pg_dump|mongo|mongosh|redis-cli|sqlcmd|sqlplus|clickhouse-client|clickhouse)$/.test(cmd)) {
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i];
      let host: string | null = null;
      const m = /^(-h|--host|-H|-S|--server)(=?)(.*)$/.exec(w);
      if (m) host = m[3] || rest[i + 1] || "";
      else if (/^\w+:\/\//.test(w)) host = hostOf(w);
      else if (cmd === "sqlplus" && /@/.test(w)) host = hostOf(w.split("@").pop() ?? "");
      if (host !== null && remoteHost(host.replace(/,\d+$/, ""))) return { label: `连接其他机器上的数据库（${host}）`, why: "可能是共享或生产的数据库；流水线只用本机或测试用的数据库" };
    }
  }
  if (/^(ssh|scp|sftp|rsync)$/.test(cmd)) {
    const target = rest.find((w) => !w.startsWith("-") && (cmd === "ssh" || cmd === "sftp" || /:/.test(w)));
    if (target && !/^git@/.test(target)) {
      const host = cmd === "ssh" || cmd === "sftp" ? hostOf(target) : hostOf(target.split(":")[0]);
      if (host && !LOCAL_HOSTS.test(host)) return { label: `登录或复制文件到其他机器（${host}）`, why: "会改动其他机器；流水线只在本地或测试环境验证" };
    }
  }
  if (/^(shutdown|reboot|halt|poweroff|mkfs|diskpart|format|stop-computer|restart-computer)$/.test(cmd) || /^mkfs\./.test(cmd)) return { label: "系统级操作", why: "会影响整台机器" };
  if (cmd === "dd" && has(/^of=\/dev\//)) return { label: "直接写磁盘", why: "会破坏磁盘上的数据" };
  if (/^(chmod|chown)$/.test(cmd) && has(/^-R$/) && rest.some((w) => /^(\/|~|\$HOME)\/?$/.test(w))) return { label: "修改整个系统的权限", why: "会影响整台机器" };
  return null;
}

/** Whether a command (or a fetched address) is one a pipeline step must not run, and why. */
export function dangerOf(text: string, settings: Pick<DangerGuardSettings, "production" | "allow">, options: { repo?: string | null; home?: string } = {}): Danger | null {
  if (!text.trim()) return null;
  for (const a of settings.allow) {
    try {
      if (new RegExp(a, "i").test(text)) return null;
    } catch {
      /* validated with the configuration */
    }
  }
  const lower = text.toLowerCase();
  for (const p of settings.production) {
    if (p.trim() && lower.includes(p.trim().toLowerCase())) return { label: `访问生产环境（${p.trim()}）`, why: "流水线不连接生产环境、不使用生产凭据" };
  }
  if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i.test(text) || /\b(iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|]*\|\s*(iex|invoke-expression)\b/i.test(text))
    return { label: "下载脚本直接执行", why: "执行的内容没有经过检查" };
  const home = options.home ?? os.homedir();
  for (const words of segments(text)) {
    const d = judgeSegment(words, options.repo ?? null, home);
    if (d) return d;
  }
  return null;
}

/** What the agent is told when the command is stopped (or was found after it ran). */
export function dangerMessage(command: string, danger: Danger, ran: boolean): string {
  const one = command.replace(/\s+/g, " ").trim();
  const clip = one.length > 160 ? `${one.slice(0, 159)}…` : one;
  return [
    `【流水线提示】${ran ? "你刚才运行了" : "已停止你正在运行的"}命令「${clip}」：这是${danger.label}，${danger.why}。需求开发流水线里不允许这类操作，用户已收到通知。`,
    "- 不要再运行这条命令，也不要换一种写法做同样的事。",
    `- ${ran ? "如果它已经改动了仓库以外或远程的东西，不要自己试图撤销；" : ""}在本步骤产物里写一节\"风险操作\"：运行了什么、为什么、${ran ? "造成了什么影响" : "是否已经产生影响"}。`,
    "- 然后继续完成本步骤的任务：需要推送、发布、部署或连接其他环境的，写进产物的\"需要人处理\"，由人来做。",
  ].join("\n");
}
