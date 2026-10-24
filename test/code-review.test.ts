// Code review in the plugin (1.14): the change as a diff, AI findings on their lines, CODEOWNERS
// reviewers, and the person's review (send back or pass).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { aiFindings, buildCodeReview, parseDiff, pendingHumanReview, readHumanReview } from "../engine/src/code-review.js";
import { matchesPattern, ownersFor, parseCodeowners } from "../engine/src/codeowners.js";
import { registerRequirement, requirementKey } from "../engine/src/records.js";
import { createReviewServer } from "../engine/src/review.js";
import { writeState } from "../engine/src/state.js";

const FEATURE = "docs/features/20261024-export";

test("CODEOWNERS：后面的规则优先；目录、通配符、锚定路径；GitLab 的分节", () => {
  const rules = parseCodeowners(["# 注释", "* @lead", "/src/order/ @zhang @li", "*.sql @dba", "docs/** @writer", "[前端][1] @fe-team", "web/", "web/admin/*.vue @wang"].join("\n"));
  assert.ok(matchesPattern("/src/order/", "src/order/export.ts"));
  assert.ok(!matchesPattern("/src/order/", "lib/src/order/x.ts"));
  assert.ok(matchesPattern("*.sql", "db/migrate/001.sql"));
  assert.ok(matchesPattern("docs/**", "docs/a/b.md"));
  assert.ok(matchesPattern("web/admin/*.vue", "web/admin/List.vue"));
  assert.ok(!matchesPattern("web/admin/*.vue", "web/admin/sub/List.vue"));
  const { byFile, all } = ownersFor(rules, ["src/order/export.ts", "db/001.sql", "README.md", "web/admin/List.vue", "web/index.ts"]);
  assert.deepEqual(byFile["src/order/export.ts"], ["@zhang", "@li"]);
  assert.deepEqual(byFile["db/001.sql"], ["@dba"]);
  assert.deepEqual(byFile["README.md"], ["@lead"]);
  // The default section and the 前端 section both apply.
  assert.deepEqual(byFile["web/admin/List.vue"], ["@lead", "@wang"]);
  assert.deepEqual(byFile["web/index.ts"], ["@lead", "@fe-team"]);
  assert.ok(all.includes("@dba") && all.includes("@fe-team"));
});

function repoWithChange() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "req-kit-cr-")));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  // The page commits code-review.md in the repository itself (CI has no global git identity).
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.mkdirSync(path.join(repo, "src", "order"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "order", "export.ts"), "export function exportOrders() {\n  return [];\n}\n");
  fs.writeFileSync(path.join(repo, "CODEOWNERS"), "* @lead\n/src/order/ @zhang\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("checkout", "-q", "-b", "feature/20261024-export");
  fs.writeFileSync(path.join(repo, "src", "order", "export.ts"), "export function exportOrders(user) {\n  const rows = load();\n  return rows;\n}\n");
  const dir = path.join(repo, FEATURE);
  fs.mkdirSync(path.join(dir, ".pipeline"), { recursive: true });
  fs.writeFileSync(path.join(dir, "spec.md"), "# 订单导出\n\n- 状态：已确认（2026-10-24）\n");
  fs.writeFileSync(path.join(dir, "handoff.md"), "# 提测说明\n\n## 这次改了什么\n\n- 订单列表可以导出\n");
  fs.writeFileSync(path.join(dir, "code-review.md"), "# 代码评审\n\n## 评审意见\n\n- **CR-1**（重要）src/order/export.ts:2 没有校验权限\n\n## 处理记录\n\n- CR-1 已修复\n");
  git("add", ".");
  git("commit", "-q", "-m", "feat: export");
  writeState(path.join(dir, ".pipeline", "state.json"), {
    schema: 1,
    repo,
    featureDir: FEATURE,
    status: "completed",
    branch: "feature/20261024-export",
    originAgentId: "chat-1",
    attempt: 1,
    history: [],
    results: { "code_review-r1": { verdict: "changes_required", findings: [{ id: "CR-1", severity: "重要", file: "src/order/export.ts", line: 2, title: "没有校验权限", suggestion: "加 checkPermission" }, { title: "缺少空数据测试", severity: "low" }] }, "code_review-r2": { verdict: "pass", findings: [] } },
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
  registerRequirement({ repo, featureDir: FEATURE, worktree: null } as never);
  return { repo, git, dir, key: requirementKey(repo, FEATURE) };
}

test("代码审查数据：相对主分支的改动、AI 意见放在对应的行、处理记录、CODEOWNERS 审核人、提测说明的概要", () => {
  const r = repoWithChange();
  const data = buildCodeReview(r.repo, FEATURE);
  assert.equal(data.base.ref, "main");
  assert.deepEqual(data.files.map((f) => [f.path, f.doc]).slice(0, 1), [["src/order/export.ts", false]]);
  assert.ok(data.files.slice(1).every((f) => f.doc), "需求文档排在后面");
  const code = data.files[0];
  assert.equal(code.additions, 3);
  assert.ok(code.hunks[0].lines.some((l) => l.t === "+" && l.n === 2 && /load\(\)/.test(l.s)));
  assert.deepEqual(data.findings.map((f) => [f.id, f.severity, f.file, f.line, f.status]), [["CR-1", "重要", "src/order/export.ts", 2, "fixed"], ["CR-1.2", "建议", null, null, "open"]]);
  assert.deepEqual(data.rounds, [{ round: 1, verdict: "changes_required" }, { round: 2, verdict: "pass" }]);
  assert.deepEqual(data.reviewers.suggested, ["@zhang"]);
  assert.equal(data.reviewers.source, "CODEOWNERS");
  assert.deepEqual(data.summary, ["- 订单列表可以导出"]);
  // Older runs: the CR items of code-review.md.
  writeState(path.join(r.dir, ".pipeline", "state.json"), { ...JSON.parse(fs.readFileSync(path.join(r.dir, ".pipeline", "state.json"), "utf8")), results: {} });
  assert.deepEqual(aiFindings(r.repo, FEATURE).findings.map((f) => [f.id, f.severity, f.file, f.line, f.status]), [["CR-1", "重要", "src/order/export.ts", 2, "fixed"]]);
  assert.equal(parseDiff("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n", FEATURE)[0].binary, true);
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test("代码审查页：退回修改写进 code-review.md 和 changes.md 并开始修改；评审通过记下审核人；有新提交后要重新评审", async () => {
  const r = repoWithChange();
  const fixes: string[] = [];
  const server = createReviewServer({ token: "t", readToken: "ro", codeFix: (_repo, fd) => (fixes.push(fd), { ok: true, message: "已在后台启动" }) });
  const base = await listen(server);
  try {
    const page = `${base}/r/t/f/${r.key}/code/`;
    assert.match(await (await fetch(page)).text(), /代码审查/);
    const info = (await (await fetch(`${page}api/info`)).json()) as { files: unknown[]; readOnly: boolean };
    assert.equal(info.readOnly, false);
    assert.equal((await fetch(`${base}/r/ro/f/${r.key}/code/api/submit`, { method: "POST", body: JSON.stringify({ verdict: "approve" }) })).status, 403);
    const empty = await fetch(`${page}api/submit`, { method: "POST", body: JSON.stringify({ verdict: "changes" }) });
    assert.equal(empty.status, 400);
    assert.equal((await fetch(`${page}api/draft`, { method: "PUT", body: JSON.stringify({ comments: [{ file: "src/order/export.ts", line: 2, text: "load 要带上用户" }] }) })).status, 200);

    const sent = (await (
      await fetch(`${page}api/submit`, {
        method: "POST",
        body: JSON.stringify({ verdict: "changes", reviewer: "王工", reviewers: ["@zhang"], comments: [{ file: "src/order/export.ts", line: 2, text: "load 要带上用户" }], fix: [{ id: "CR-1.2", note: "补一个空数据的测试" }], note: "" }),
      })
    ).json()) as { ok: boolean; message: string };
    assert.equal(sent.ok, true, sent.message);
    assert.match(sent.message, /已记录 2 条修改意见，流水线开始按意见修改/);
    assert.deepEqual(fixes, [FEATURE]);
    const review = fs.readFileSync(path.join(r.dir, "code-review.md"), "utf8");
    assert.match(review, /## 人工评审（\d{4}-\d{2}-\d{2}，王工）/);
    assert.match(review, /\*\*HR-1\*\* AI 评审意见 CR-1\.2（建议）：缺少空数据测试。评审人补充：补一个空数据的测试/);
    assert.match(review, /\*\*HR-2\*\* \[src\/order\/export\.ts:2\] load 要带上用户/);
    assert.match(fs.readFileSync(path.join(r.dir, "changes.md"), "utf8"), /人工代码评审退回（第 1 次）[\s\S]*来源：人工代码评审/);
    assert.equal(r.git("log", "-1", "--format=%s").trim(), "docs(20261024-export): 人工代码评审意见");
    assert.equal(pendingHumanReview(r.dir)?.items.length, 2);
    assert.ok(!fs.existsSync(path.join(r.dir, ".pipeline", "code-review", "draft.json")), "提交后草稿清掉");

    const headAtReview = r.git("rev-parse", "HEAD").trim();
    const ok = (await (await fetch(`${page}api/submit`, { method: "POST", body: JSON.stringify({ verdict: "approve", reviewer: "王工", reviewers: ["@zhang", "@lead"] }) })).json()) as { message: string };
    assert.match(ok.message, /已记录：评审通过，已写入 code-review\.md 并提交。审核人：@zhang、@lead。/);
    const h = readHumanReview(r.dir)!;
    assert.equal(h.status, "approved");
    assert.equal(h.head, headAtReview);
    // A commit after the review: it has to be looked at again.
    fs.appendFileSync(path.join(r.repo, "src", "order", "export.ts"), "// later\n");
    r.git("commit", "-qam", "fix: later");
    const again = (await (await fetch(`${page}api/info`)).json()) as { human: { stale: boolean } };
    assert.equal(again.human.stale, true);
  } finally {
    server.close();
  }
});
