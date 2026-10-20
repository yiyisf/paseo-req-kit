// The scan guard (1.13): which commands search a very large directory.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runningToolOf } from "../src/activity.js";
import { bigDirOf, judge } from "../src/scan-guard.js";

const home = "/home/u";

test("大目录搜索：认出整个磁盘、用户目录、.m2、全局 node_modules；具体的子目录、排除掉的目录和普通命令不算", () => {
  const big: Array<[string, string]> = [
    ["find / -name '*.jar'", "整个磁盘（/）"],
    ['bash -lc "find / -name x 2>/dev/null"', "整个磁盘（/）"],
    ["find ~ -name Foo.class", "用户目录"],
    ["grep -r Foo /home/u", "用户目录"],
    ["find /home/u/.m2/repository -name x", "Maven 本地仓库（.m2）"],
    ["Get-ChildItem $env:USERPROFILE\\.m2 -Recurse", "Maven 本地仓库（.m2）"],
    ["grep -rl Foo ~/.gradle/caches", "Gradle 缓存（.gradle）"],
    ["rg Foo node_modules", "node_modules"],
    ["ls -R $(npm root -g)", "全局 node_modules"],
    ["Get-ChildItem -Path C:\\ -Recurse -Filter *.jar", "整个磁盘"],
    ['dir /s "C:\\Program Files"', "系统目录"],
    ["find /usr -name libx", "系统目录"],
  ];
  for (const [command, label] of big) assert.equal(bigDirOf(command, { home }), label, command);
  for (const command of [
    "find ~/.m2/repository/com/acme/foo -name '*.jar'",
    "grep -rn Foo /home/u/proj/src",
    "rg Foo node_modules/lodash",
    "grep -r Foo . --exclude-dir=node_modules",
    "rg Foo -g '!node_modules' .",
    "cat ~/.m2/settings.xml",
    "ls ~/.m2",
    "mvn -q test",
    "find . -name '*.java'",
  ])
    assert.equal(bigDirOf(command, { home }), null, command);
  assert.equal(bigDirOf("grep -r Foo D:/share", { home, paths: ["D:\\share"] }), "D:\\share");
});

test("大目录搜索：给一分钟再打断；任何搜索超过设定的分钟数也打断；构建不打断", () => {
  const settings = { enabled: true, minutes: 5, paths: [] };
  const now = new Date("2026-10-20T10:00:00Z");
  const at = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  const tool = (text: string, min: number, kind = "shell") => ({ kind, text, startedAt: at(min), callId: "c" });
  assert.equal(judge(tool("find / -name x", 0.5), settings, now, home), null);
  assert.match(judge(tool("find / -name x", 1.5), settings, now, home)?.reason ?? "", /在搜索整个磁盘/);
  assert.equal(judge(tool("rg Foo src", 3), settings, now, home), null);
  assert.match(judge(tool("rg Foo src", 6), settings, now, home)?.reason ?? "", /已经运行了 6 分钟/);
  assert.match(judge(tool("OrderService", 6, "search"), settings, now, home)?.reason ?? "", /已经运行了 6 分钟/);
  assert.equal(judge(tool("mvn -q install", 40), settings, now, home), null);
  assert.equal(judge(tool("find / -name x", 9), { ...settings, enabled: false }, now, home), null);
});

test("正在运行的工具调用：取时间线里最后一个还没结束的，开始时间是它第一次出现的时间", () => {
  const entries = [
    { timestamp: "2026-10-20T10:00:00Z", item: { type: "tool_call", callId: "a", status: "running", detail: { type: "shell", command: "ls" } } },
    { timestamp: "2026-10-20T10:00:01Z", item: { type: "tool_call", callId: "a", status: "completed", detail: { type: "shell", command: "ls" } } },
    { timestamp: "2026-10-20T10:01:00Z", item: { type: "tool_call", callId: "b", status: "running", detail: { type: "shell", command: ["bash", "-lc", "find / -name x"] } } },
    { timestamp: "2026-10-20T10:01:30Z", item: { type: "assistant_message", text: "…" } },
  ];
  assert.deepEqual(runningToolOf(entries), { kind: "shell", text: "bash -lc find / -name x", startedAt: "2026-10-20T10:01:00Z", callId: "b" });
  assert.equal(runningToolOf(entries.slice(0, 2)), null);
});
