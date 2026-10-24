// 1.14: events after the runs (people's code reviews, acceptance, merges, problems after the
// merge) in the usage records and in `req stats`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { mergeOf, scanOutcomes } from "../src/outcomes.js";
import { appendEvent, type EventRecord, readEvents, registerRequirement, requirementRef, type RunRecord, runsFile } from "../src/records.js";
import { describeStats, parsePeriod, statsCsv, summarizeRuns } from "../src/stats.js";

function freshHome(): void {
  process.env.REQ_KIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-outcome-home-"));
}

function repo(): { dir: string; git: (...a: string[]) => string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-outcome-")));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { dir, git };
}

function feature(dir: string, fd: string, title: string, extra = "", files: Record<string, string> = {}): void {
  fs.mkdirSync(path.join(dir, fd), { recursive: true });
  fs.writeFileSync(path.join(dir, fd, "spec.md"), `# ${title}\n\n- 状态：已确认（2026-10-20）\n${extra}`);
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, fd, f), c);
}

test("合并：需求的流水线文件进了主干就算合并（合并提交的时间）；只有需求说明不算；同一个需求只记一次", () => {
  freshHome();
  const r = repo();
  const A = "docs/features/20261020-export";
  r.git("checkout", "-q", "-b", "feature/20261020-export");
  feature(r.dir, A, "订单导出", "", { "implementation.md": "# 实现\n", "report.md": "# 报告\n" });
  r.git("add", ".");
  r.git("commit", "-q", "-m", "feat");
  registerRequirement({ repo: r.dir, featureDir: A, worktree: null } as never);
  assert.equal(mergeOf(r.dir, A), null, "还没合并");
  // Only the spec in main (spec committed before the branch): not merged.
  r.git("checkout", "-q", "main");
  const B = "docs/features/20261021-sms";
  feature(r.dir, B, "短信登录");
  r.git("add", ".");
  r.git("commit", "-q", "-m", "spec");
  registerRequirement({ repo: r.dir, featureDir: B, worktree: null } as never);
  assert.equal(scanOutcomes().length, 0);

  r.git("merge", "-q", "--no-ff", "-m", "Merge export", "feature/20261020-export");
  const merge = r.git("rev-parse", "HEAD").trim().slice(0, 12);
  const found = scanOutcomes();
  assert.deepEqual(found.map((e) => [e.kind, e.requirement.title, e.merge?.commit, e.merge?.into]), [["merge", "订单导出", merge, "main"]]);
  assert.equal(scanOutcomes().length, 0, "已经记过");
  assert.equal(readEvents(runsFile()).filter((e) => e.kind === "merge").length, 1);
});

test("合并后的问题：缺陷需求写了\"引入问题的需求\"就记到那个需求上，只记一次", () => {
  freshHome();
  const r = repo();
  const A = "docs/features/20261020-export";
  const D = "docs/features/20261023-export-empty";
  feature(r.dir, A, "订单导出");
  feature(r.dir, D, "导出空数据报错", "- 类型：缺陷\n- 引入问题的需求：20261020-export\n");
  registerRequirement({ repo: r.dir, featureDir: A, worktree: null } as never);
  registerRequirement({ repo: r.dir, featureDir: D, worktree: null } as never);
  const found = scanOutcomes();
  assert.deepEqual(found.map((e) => [e.kind, e.requirement.title, e.issue?.text, e.issue?.by]), [["issue", "订单导出", "导出空数据报错", "20261023-export-empty"]]);
  assert.equal(scanOutcomes().length, 0);
});

function run(key: string, end: string): RunRecord {
  return {
    schema: 1,
    kind: "run",
    machine: "pc-1",
    kitVersion: "1.14.0",
    requirement: { key, project: "shop", name: key, title: `需求 ${key}`, type: null, profile: "standard" },
    run: { startedAt: "2026-10-20T00:00:00Z", endedAt: end, attempt: 1, phase: "develop", phaseMode: "continuous", status: "completed", outcome: "completed", stopReason: null },
    agents: { builder: "b", reviewer: "r" },
    steps: [],
    gate: { runs: 0, failed: 0 },
  };
}

function ev(key: string, at: string, rest: Partial<EventRecord> & { kind: EventRecord["kind"] }): EventRecord {
  return { schema: 1, machine: "pc-1", kitVersion: "1.14.0", at, requirement: { key, project: "shop", name: key, title: `需求 ${key}` }, ...rest };
}

test("req stats：人工评审退回次数、第一次就通过、验收、合并用时、合并后问题；每个需求一行里也有", () => {
  const runs = [run("a", "2026-10-21T00:00:00Z"), run("b", "2026-10-22T00:00:00Z")];
  const events = [
    ev("a", "2026-10-21T02:00:00Z", { kind: "review", review: { verdict: "changes_requested", reviewer: "王工", items: 3, head: null } }),
    ev("a", "2026-10-21T05:00:00Z", { kind: "review", review: { verdict: "approved", reviewer: "王工", items: 0, head: null } }),
    ev("b", "2026-10-22T01:00:00Z", { kind: "review", review: { verdict: "approved", reviewer: "李工", items: 0, head: null } }),
    ev("a", "2026-10-21T06:00:00Z", { kind: "acceptance", acceptance: { verdict: "通过", reviewer: "运营", total: 4, passed: 4, failed: 0, unchecked: 0 } }),
    ev("a", "2026-10-21T08:00:00Z", { kind: "merge", merge: { into: "main", commit: "abc", mergedAt: "2026-10-21T10:00:00Z", how: "files" } }),
    ev("a", "2026-10-23T00:00:00Z", { kind: "issue", issue: { text: "空数据报错", by: "x", id: "defect:x" } }),
    // The same issue exported twice counts once.
    ev("a", "2026-10-23T00:00:00Z", { kind: "issue", issue: { text: "空数据报错", by: "x", id: "defect:x" } }),
  ];
  const s = summarizeRuns(runs, parsePeriod({ month: "2026-10" }), events);
  assert.deepEqual(s.oversight, {
    reviews: { total: 3, requirements: 2, sentBack: 1, passedFirstTime: 1, items: 3 },
    acceptance: { total: 1, requirements: 1, failed: 0, passedFirstTime: 1 },
    merged: { requirements: 1, medianHoursAfterCompletion: 10 },
    issues: { total: 1, requirements: 1 },
  });
  const a = s.requirements.find((q) => q.key === "a")!;
  assert.deepEqual(a.afterRun, { humanReviews: 2, sentBack: 1, lastReview: "approved", acceptance: "通过", acceptanceFailed: 0, mergedAt: "2026-10-21T10:00:00Z", issues: 1 });
  const md = describeStats(s);
  assert.match(md, /人工代码评审：3 次（2 个需求），退回修改 1 次、共 3 条意见；第一次评审就通过的需求 1 个/);
  assert.match(md, /合并进主干：1 个需求，完成到合并中位数 10 小时/);
  assert.match(md, /合并后发现的问题：1 个（1 个需求），按合并的需求算 100%/);
  assert.match(md, /\| 通过（退回 1 次） \| 通过 \| 2026-10-21 \| 1 \|/);
  assert.match(statsCsv(s).split("\n")[0], /human_reviews,human_sent_back,last_human_review,acceptance,acceptance_failed,merged_at,issues_after_merge/);
});

test("评审和验收记录的需求和运行记录对得上（同一个 key）", () => {
  freshHome();
  const r = repo();
  const A = "docs/features/20261020-export";
  feature(r.dir, A, "订单导出");
  registerRequirement({ repo: r.dir, featureDir: A, worktree: null } as never);
  const ref = requirementRef(r.dir, A);
  assert.equal(ref.title, "订单导出");
  appendEvent({ kind: "review", requirement: ref, review: { verdict: "approved", reviewer: "王工", items: 0, head: null } });
  assert.equal(readEvents(runsFile())[0].requirement.key, ref.key);
});
