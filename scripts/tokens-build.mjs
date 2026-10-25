#!/usr/bin/env node
// Builds design/reference/tokens.css (the --rk-* variables) from design/tokens.json.
// `node scripts/tokens-build.mjs --check` fails when the committed file is out of date.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tokens = JSON.parse(fs.readFileSync(path.join(root, "design", "tokens.json"), "utf8"));
const out = path.join(root, "design", "reference", "tokens.css");

const byName = new Map(tokens.color.tokens.map((t) => [t.name, t]));
const resolve = (value, theme, seen = new Set()) => {
  let v = typeof value === "string" ? value : (value[theme] ?? value[tokens.color.themes[0].id]);
  const alias = /^\{(.+)\}$/.exec(v);
  if (!alias) return v;
  if (seen.has(alias[1])) throw new Error(`token alias loop at ${alias[1]}`);
  seen.add(alias[1]);
  const target = byName.get(alias[1]);
  if (!target) throw new Error(`unknown token ${alias[1]}`);
  return resolve(target.value, theme, seen);
};

const block = (theme) => {
  const lines = tokens.color.tokens.map((t) => `  --rk-${t.name}: ${resolve(t.value, theme)};`);
  for (const t of tokens.shadow.tokens) lines.push(`  --rk-${t.name}: ${typeof t.value === "string" ? t.value : (t.value[theme] ?? t.value.dark)};`);
  return lines.join("\n");
};

const shared = [];
for (const [k, v] of Object.entries(tokens.type.families)) shared.push(`  --rk-font-${k}: ${v};`);
for (const g of tokens.type.groups) {
  for (const s of g.styles) {
    const fam = `var(--rk-font-${g.family})`;
    shared.push(`  --rk-type-${s.name}: ${s.fontWeight} ${s.fontSize}/${s.lineHeight} ${fam};`);
    if (s.letterSpacing) shared.push(`  --rk-tracking-${s.name}: ${s.letterSpacing};`);
  }
}
for (const fam of ["spacing", "radius", "zIndex"]) for (const t of tokens[fam].tokens) shared.push(`  --rk-${t.name}: ${t.value};`);

const css = `/* req-kit — generated from design/tokens.json by scripts/tokens-build.mjs. Do not edit. */
/* Dark is the default; light applies with data-theme="light", or the system setting when no data-theme is set. */
:root {
${shared.join("\n")}
${block("dark")}
  color-scheme: dark;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
${block("light").replace(/^/gm, "  ")}
    color-scheme: light;
  }
}
:root[data-theme="light"] {
${block("light")}
  color-scheme: light;
}
`;

if (process.argv.includes("--check")) {
  const now = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  if (now !== css) {
    console.error("design/reference/tokens.css is out of date: run node scripts/tokens-build.mjs");
    process.exit(1);
  }
  console.log("tokens.css is up to date");
} else {
  fs.writeFileSync(out, css);
  console.log(`wrote ${path.relative(root, out)}`);
}
