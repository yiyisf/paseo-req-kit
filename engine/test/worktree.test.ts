// The requirement's own worktree (1.14): a start can be done again, the alignment's other files
// go along, and requirements show in the plugin from the interview on.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { apiList, NOT_STARTED_AFTER_MS, startOptions } from "../src/api.js";
import { readIndex, trackRequirement } from "../src/records.js";
import { moveToOwnWorktree, readWorktreeRecord } from "../src/worktree.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const FEATURE = "docs/features/20261022-export";

function repoWithSpec(confirmed = true): { repo: string; git: (...a: string[]) => string } {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "req-wt-repo-")));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "README.md"), "app\n");
  fs.writeFileSync(path.join(repo, "GLOSSARY.md"), "# 术语\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  fs.mkdirSync(path.join(repo, FEATURE), { recursive: true });
  fs.writeFileSync(path.join(repo, FEATURE, "spec.md"), `# 订单导出\n\n- 状态：${confirmed ? "已确认（2026-10-22）" : "草稿"}\n- 档位：标准\n`);
  fs.writeFileSync(path.join(repo, FEATURE, "alignment.md"), "# 访谈记录\n");
  return { repo, git };
}

function fakeRuntime(created: string[]) {
  let n = 0;
  return {
    async createWorktree(request: { sourceRepo: string; baseRef: string; branchName: string }) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "req-wt-"));
      fs.rmSync(directory, { recursive: true });
      execFileSync("git", ["worktree", "add", "-q", "-b", request.branchName, directory, request.baseRef], { cwd: request.sourceRepo, stdio: "pipe" });
      created.push(directory);
      n += 1;
      return { workspaceId: `wks-${n}`, directory };
    },
    async openWorkspace(directory: string) {
      created.push(`open:${directory}`);
      return { workspaceId: "wks-opened" };
    },
  };
}

function home(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "req-wt-home-"));
  process.env.REQ_KIT_HOME = dir;
  return { ...process.env, REQ_KIT_HOME: dir };
}

test("自己的工作区：建好后中途失败，再次启动在同一个工作区接着做；访谈改过的术语表一起带过去", async () => {
  const env = home();
  const { repo, git } = repoWithSpec();
  fs.appendFileSync(path.join(repo, "GLOSSARY.md"), "- 导出：把订单列表存成文件\n");
  fs.mkdirSync(path.join(repo, "docs", "adr"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs", "adr", "0007-export.md"), "# 导出用 CSV\n");
  fs.writeFileSync(path.join(repo, "notes.txt"), "无关的改动\n");
  const created: string[] = [];
  const runtime = fakeRuntime(created);
  const first = await moveToOwnWorktree({ runtime, sourceRepo: repo, featureDir: FEATURE, originAgentId: "chat-1", title: "订单导出", env });
  assert.equal(first.reused, false);
  assert.deepEqual(first.carried.sort(), ["GLOSSARY.md", "docs/adr/0007-export.md"]);
  assert.ok(first.warnings.some((w) => /1 处未提交的改动和这个需求无关/.test(w)), first.warnings.join("\n"));
  const committed = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: first.repo, encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(committed, ["GLOSSARY.md", "docs/adr/0007-export.md", `${FEATURE}/alignment.md`, `${FEATURE}/spec.md`]);
  assert.ok(!fs.existsSync(path.join(repo, FEATURE)), "主目录中未提交的需求文件已移走");
  assert.match(fs.readFileSync(path.join(repo, "GLOSSARY.md"), "utf8"), /导出/, "主目录里术语表的改动保留");
  assert.equal(readWorktreeRecord(repo, FEATURE, env)?.workspaceId, "wks-1");
  // The plugin finds it where it now lives, under the chat's project.
  const entry = readIndex(env).find((e) => e.featureDir === FEATURE)!;
  assert.equal(entry.repo, first.repo);
  assert.equal(entry.sourceRepo, repo);
  assert.equal(entry.chatAgentId, "chat-1");

  // The start failed after this point: the next one uses the same worktree, nothing new is made.
  const again = await moveToOwnWorktree({ runtime, sourceRepo: repo, featureDir: FEATURE, originAgentId: "chat-1", title: "订单导出", env });
  assert.equal(again.reused, true);
  assert.equal(again.repo, first.repo);
  assert.equal(again.workspaceId, "wks-1");
  assert.equal(created.length, 1);
  assert.equal(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: first.repo, encoding: "utf8" }).trim(), "2", "没有重复提交");
  void git;
});

test("自己的工作区：旧版本留下的分支和工作区（没有记录）由 Paseo 接手；只有分支没有目录时说明怎么办", async () => {
  const env = home();
  const { repo, git } = repoWithSpec();
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "req-wt-old-")), "wt");
  git("worktree", "add", "-q", "-b", "feature/20261022-export", dir, "main");
  const created: string[] = [];
  const moved = await moveToOwnWorktree({ runtime: fakeRuntime(created), sourceRepo: repo, featureDir: FEATURE, originAgentId: null, title: "订单导出", env });
  assert.equal(moved.reused, true);
  assert.equal(moved.workspaceId, "wks-opened");
  assert.equal(created.length, 1);
  assert.match(created[0], /^open:/);
  assert.ok(fs.existsSync(path.join(moved.repo, FEATURE, "spec.md")));

  const other = repoWithSpec();
  other.git("branch", "feature/20261022-export");
  await assert.rejects(
    moveToOwnWorktree({ runtime: fakeRuntime([]), sourceRepo: other.repo, featureDir: FEATURE, originAgentId: null, title: "订单导出", env }),
    /分支 feature\/20261022-export 已经存在，但没有对应的工作区目录。如果它是以前没有启动成功留下的空分支/,
  );
});

test("自己的工作区：需求说明已经提交在主分支上时如实提示", async () => {
  const env = home();
  const { repo, git } = repoWithSpec();
  git("add", FEATURE);
  git("commit", "-q", "-m", "docs: 需求说明");
  const moved = await moveToOwnWorktree({ runtime: fakeRuntime([]), sourceRepo: repo, featureDir: FEATURE, originAgentId: null, title: "订单导出", env });
  assert.ok(moved.warnings.some((w) => /需求文件已经提交在 main 上/.test(w)), moved.warnings.join("\n"));
  assert.equal(moved.removedSource, false);
});

test("从需求对齐开始显示：登记后列为对齐中；确认后久未开始进等你处理，可以从插件开始（新建工作区、发回原对话）", async () => {
  home();
  const { repo } = repoWithSpec(false);
  fs.rmSync(path.join(repo, FEATURE, "spec.md"));
  const tracked = spawnSync(process.execPath, [path.join(ROOT, "bin", "start-pipeline.mjs"), "--feature", FEATURE, "--track"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PASEO_AGENT_ID: "chat-7", PASEO_AGENT_CWD: repo },
  });
  assert.equal(tracked.status, 0, tracked.stderr);
  assert.match(tracked.stdout, /已登记需求：docs\/features\/20261022-export（Paseo 的 req-kit 插件里能看到它，状态"对齐中"，关联这个对话）/);
  const aligning = apiList({ repo, all: true }).find((x) => x.featureDir === FEATURE)!;
  assert.equal(aligning.stage, "对齐中");
  assert.equal(aligning.attention, null);

  // Confirmed a while ago and nobody started it.
  const spec = path.join(repo, FEATURE, "spec.md");
  fs.writeFileSync(spec, "# 订单导出\n\n- 状态：已确认（2026-10-22）\n- 档位：标准\n");
  const old = new Date(Date.now() - NOT_STARTED_AFTER_MS - 60_000);
  fs.utimesSync(spec, old, old);
  for (const f of ["alignment.md", ".pipeline/tracked.json"]) fs.utimesSync(path.join(repo, FEATURE, f), old, old);
  const waiting = apiList({ repo, all: true }).find((x) => x.featureDir === FEATURE)!;
  assert.equal(waiting.stage, "已确认，未开始开发");
  assert.equal(waiting.attention, "not_started");
  assert.equal(waiting.waiting?.canStart, true);
  assert.match(waiting.waiting?.reason ?? "", /需求说明已经确认，但开发还没有开始/);
  // Started from the plugin: in the main checkout it gets its own worktree, and reports to the chat.
  assert.deepEqual(startOptions(repo, FEATURE), ["--worktree", "--origin-agent", "chat-7"]);

  // Not registered at all: found in a project the machine knows.
  const name = "docs/features/20261022-import";
  fs.mkdirSync(path.join(repo, name), { recursive: true });
  fs.writeFileSync(path.join(repo, name, "alignment.md"), "# 访谈记录：订单导入\n");
  assert.equal(apiList({ repo, all: true }).find((x) => x.featureDir === name)?.title, "订单导入");
  trackRequirement(repo, name, null);
  assert.equal(apiList({ repo, all: true }).filter((x) => x.featureDir === name).length, 1);
});
