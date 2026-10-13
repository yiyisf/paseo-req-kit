import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKILLS = path.join(ROOT, "skills");
const KNOWN = new Set(["{{REQ_KIT_ROOT}}", "{{PIPELINE_LAUNCHER}}", "{{REQ_KIT_VERSION}}"]);

function markdownFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? markdownFiles(full) : e.name.endsWith(".md") ? [full] : [];
  });
}

test("每个 skill 的 frontmatter：name 与目录名一致，有 description，不含会破坏 YAML 的半角冒号加空格", () => {
  for (const name of fs.readdirSync(SKILLS)) {
    const text = fs.readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf8");
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(front, `${name}：缺少 frontmatter`);
    assert.match(front[1], new RegExp(`^name: ${name}$`, "m"), `${name}：name 与目录名不一致`);
    const description = /^description: (.+)$/m.exec(front[1]);
    assert.ok(description && description[1].length < 1024, `${name}：description 缺失或过长`);
    assert.ok(!/: /.test(description[1]), `${name}：description 中有 ": "，会被 YAML 误读`);
  }
});

test("skill 中只用已知的占位符，引用的安装目录内文件都存在", () => {
  for (const file of markdownFiles(SKILLS)) {
    const text = fs.readFileSync(file, "utf8");
    for (const placeholder of text.match(/\{\{[A-Z_]+\}\}/g) ?? []) {
      assert.ok(KNOWN.has(placeholder), `${file}：未知占位符 ${placeholder}`);
    }
    for (const [, rel] of text.matchAll(/\{\{REQ_KIT_ROOT\}\}\/([\w./-]+)/g)) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `${file} 引用了不存在的 ${rel}`);
    }
  }
});

test("原则索引中的七条原则都有对应的 skill", () => {
  const index = fs.readFileSync(path.join(ROOT, "principles", "INDEX.md"), "utf8");
  const names = [...index.matchAll(/`(principle-[a-z-]+)`/g)].map((m) => m[1]);
  assert.equal(names.length, 7);
  for (const name of names) assert.ok(fs.existsSync(path.join(SKILLS, name, "SKILL.md")), `缺少 ${name}`);
});

test("/req 的每本手册都有\"步骤\"一节，且都在入口的路由表中", () => {
  const dir = path.join(SKILLS, "req", "playbooks");
  const entry = fs.readFileSync(path.join(SKILLS, "req", "SKILL.md"), "utf8");
  const playbooks = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.equal(playbooks.length, 8);
  for (const file of playbooks) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    assert.match(text, /^## 步骤\n\n1\. /m, `${file} 缺少"步骤"一节`);
    assert.ok(entry.includes(`skills/req/playbooks/${file}`), `${file} 不在 /req 的路由表中`);
  }
});
