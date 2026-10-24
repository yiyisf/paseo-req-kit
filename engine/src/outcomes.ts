// What happened after the run (1.14): whether each requirement's change reached the main line,
// and problems found after that. Recorded as events in the usage records (records.ts), so
// `req stats` can report merges and post-merge problems next to the runs. Merges are found
// from what is already in the local repository (no fetch): the requirement's pipeline files
// (implementation.md, report.md, …) are in the main line's tree. A defect requirement whose spec
// says "- 引入问题的需求：<目录名或标题>" counts as a problem of that requirement.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PIPELINE_OUTPUTS } from "./features.js";
import { appendEvent, type EventRecord, type IndexEntry, readEvents, readIndex, requirementRef, runsFile } from "./records.js";

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  } catch {
    return null;
  }
}

/** The main line of a repository as known locally: origin's default branch, else main or master. */
export function mainLine(repo: string): string | null {
  const head = git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?.trim();
  for (const ref of [head, "origin/main", "origin/master", "main", "master"]) {
    if (ref && git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== null) return ref;
  }
  return null;
}

/** Whether the requirement's change is in the main line, with the commit that brought it there. */
export function mergeOf(repo: string, featureDir: string): NonNullable<EventRecord["merge"]> | null {
  const ref = mainLine(repo);
  if (!ref) return null;
  const fd = featureDir.split(path.sep).join("/");
  const marker = PIPELINE_OUTPUTS.find((f) => git(repo, ["cat-file", "-e", `${ref}:${fd}/${f}`]) !== null);
  if (!marker) return null;
  const line = git(repo, ["log", "--first-parent", "--diff-filter=A", "-1", "--format=%H%x09%cI", ref, "--", `${fd}/${marker}`])?.trim() ?? "";
  const [commit, at] = line.split("\t");
  return { into: ref, commit: commit ? commit.slice(0, 12) : null, mergedAt: at || null, how: "files" };
}

/** The spec of a requirement: in its directory, or (worktree removed) in the main line. */
function specOf(entry: IndexEntry): string | null {
  const file = path.join(entry.repo, entry.featureDir, "spec.md");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  const repo = [entry.sourceRepo, entry.repo].find((r): r is string => !!r && fs.existsSync(r));
  const ref = repo ? mainLine(repo) : null;
  return repo && ref ? git(repo, ["show", `${ref}:${entry.featureDir}/spec.md`]) : null;
}

const CAUSED_BY = /^\s*[-*]\s*引入问题的需求[:：]\s*(.+?)\s*$/m;

/**
 * Looks at every requirement this machine knows (the index) and records what is new: merges
 * into the main line, and defect requirements that name the requirement that caused them.
 * Returns the events it added. Never throws.
 */
export function scanOutcomes(env: NodeJS.ProcessEnv = process.env): EventRecord[] {
  const added: EventRecord[] = [];
  try {
    const events = readEvents(runsFile(env));
    const merged = new Set(events.filter((e) => e.kind === "merge").map((e) => `${e.requirement.project}\0${e.requirement.key}`));
    const issues = new Set(events.filter((e) => e.kind === "issue").map((e) => e.issue?.id));
    const entries = readIndex(env);
    for (const entry of entries) {
      const repo = [entry.sourceRepo, entry.repo].find((r): r is string => !!r && fs.existsSync(r));
      if (!repo) continue;
      const ref = requirementRef(entry.repo, entry.featureDir, env);
      if (!merged.has(`${ref.project}\0${ref.key}`)) {
        const m = mergeOf(repo, entry.featureDir);
        if (m) {
          const e = { kind: "merge" as const, requirement: ref, merge: m };
          appendEvent(e, env);
          added.push({ schema: 1, machine: "", kitVersion: "", at: new Date().toISOString(), ...e });
          merged.add(`${ref.project}\0${ref.key}`);
        }
      }
      const cause = CAUSED_BY.exec(specOf(entry) ?? "")?.[1];
      const id = `defect:${entry.key}`;
      if (!cause || issues.has(id)) continue;
      const target = entries.find((o) => o.key !== entry.key && (path.basename(o.featureDir) === cause || o.featureDir === cause || requirementRef(o.repo, o.featureDir, env).title === cause));
      if (!target) continue;
      const e = { kind: "issue" as const, requirement: requirementRef(target.repo, target.featureDir, env), issue: { text: ref.title, by: ref.name, id } };
      appendEvent(e, env);
      added.push({ schema: 1, machine: "", kitVersion: "", at: new Date().toISOString(), ...e });
      issues.add(id);
    }
  } catch {
    // Outcomes are a convenience for the statistics.
  }
  return added;
}

const USAGE = `用法：
  req outcome                          查找已经合并进主干的需求、合并后发现的问题（缺陷需求里写了"引入问题的需求"），记入使用记录
  req outcome <需求> --merged [--commit <提交>]   手动记一笔：这个需求已经合并（例如合并后删掉了需求目录）
  req outcome <需求> --issue "<问题>"             手动记一笔：这个需求合并后发现的问题

合并是从本机仓库里已有的分支判断的，判断前可以先 git fetch。结果在 req stats 里看。`;

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const feature = argv.find((a, i) => !a.startsWith("--") && !["--issue", "--commit"].includes(argv[i - 1] ?? ""));
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  if (!feature) {
    const added = scanOutcomes();
    if (added.length === 0) console.log("没有新的合并或合并后问题。");
    for (const e of added) {
      console.log(e.kind === "merge" ? `已合并：${e.requirement.title}（${e.merge!.into}${e.merge!.commit ? `，${e.merge!.commit}` : ""}）` : `合并后的问题：${e.requirement.title} ← ${e.issue!.by}「${e.issue!.text}」`);
    }
    return 0;
  }
  const { locate } = await import("./api.js");
  const { repo, featureDir } = locate(process.cwd(), feature);
  const requirement = requirementRef(repo, featureDir);
  if (argv.includes("--merged")) {
    appendEvent({ kind: "merge", requirement, merge: { into: mainLine(repo) ?? "main", commit: value("--commit"), mergedAt: null, how: "manual" } });
    console.log(`已记录：${requirement.title} 已合并。`);
    return 0;
  }
  const text = value("--issue");
  if (text && !text.startsWith("--")) {
    appendEvent({ kind: "issue", requirement, issue: { text: text.slice(0, 500), by: null, id: `manual:${Date.now()}` } });
    console.log(`已记录：${requirement.title} 合并后的问题「${text.slice(0, 80)}」。`);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: Error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
