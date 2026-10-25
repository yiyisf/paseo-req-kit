#!/usr/bin/env node
// Builds design/reference/tokens.css (the --rk-* variables) from design/tokens.json.
// Also copies tokens.css, components.css and icons.js into engine/src/review-assets for the review pages.
// `node scripts/tokens-build.mjs --check` fails when any output is out of date.
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

// The review pages ship inside the npm package (engine/src/review-assets), which does not carry
// design/: they get copies of the tokens, the component styles and the icons.
const assets = path.join(root, "engine", "src", "review-assets");
const banner = (from) => `/* Copied from ${from} by scripts/tokens-build.mjs. Do not edit here. */\n`;
const outputs = [
  [out, css],
  [path.join(assets, "rk-tokens.css"), css],
  [path.join(assets, "rk.css"), banner("design/reference/components.css") + fs.readFileSync(path.join(root, "design", "reference", "components.css"), "utf8")],
  [path.join(assets, "rk-icons.js"), banner("design/examples/icons.js") + fs.readFileSync(path.join(root, "design", "examples", "icons.js"), "utf8")],
];

// The Paseo plugin draws with React Native in Paseo's own theme; it takes only req-kit's accent
// colors (lime, AI, data and the status tints), for both themes.
const PLUGIN_COLORS = ["brand-500", "brand-400", "brand-edge", "brand-text", "brand-tint", "on-brand", "ai", "ai-tint", "data", "data-tint", "success-tint", "warning-tint", "failed-tint"];
const camel = (n) => n.replace(/-(\w)/g, (_, c) => c.toUpperCase());
const pluginSet = (theme) => Object.fromEntries(PLUGIN_COLORS.map((n) => [camel(n), resolve(byName.get(n).value, theme)]));
outputs.push([
  path.join(root, "paseo-plugin", "shared", "rk-colors.ts"),
  `// req-kit accent colors for the Paseo plugin, generated from design/tokens.json by scripts/tokens-build.mjs. Do not edit.\nexport const RK_COLORS = ${JSON.stringify({ dark: pluginSet("dark"), light: pluginSet("light") }, null, 2)} as const;\n\nexport type RkColors = (typeof RK_COLORS)["dark"];\n`,
]);

// The docs site (VitePress) switches themes with a "dark" class on <html> and defaults to light,
// so it gets its own variable file; the component styles come without the page-wide body/link rules
// (VitePress owns those), and the icons as a module the Vue components can render on the server.
const theme = path.join(root, "site", ".vitepress", "theme");
outputs.push([
  path.join(theme, "rk-tokens.css"),
  `/* req-kit — generated from design/tokens.json by scripts/tokens-build.mjs. Do not edit. */\n:root {\n${shared.join("\n")}\n${block("light")}\n}\n.dark {\n${block("dark")}\n}\n`,
]);
const components = fs.readFileSync(path.join(root, "design", "reference", "components.css"), "utf8");
outputs.push([
  path.join(theme, "rk.css"),
  banner("design/reference/components.css (without the body and link rules)") +
    components
      .split("\n")
      .filter((l) => !/^(body|a:not\(\.rk-btn\))\{/.test(l))
      .join("\n"),
]);
const iconSource = fs.readFileSync(path.join(root, "design", "examples", "icons.js"), "utf8");
const iconMap = /const I = (\{[\s\S]*?\n  \});/.exec(iconSource);
if (!iconMap) throw new Error("design/examples/icons.js: icon map not found");
const icons = new Function(`return ${iconMap[1]}`)();
outputs.push([
  path.join(theme, "rk-icons.ts"),
  `// Lucide icon paths from design/examples/icons.js, generated by scripts/tokens-build.mjs. Do not edit.\nexport const ICONS: Record<string, string> = ${JSON.stringify(icons, null, 2)};\n`,
]);
for (const [from, to] of [["reqkit-mark-dark.svg", "logo.svg"], ["reqkit-mark-light.svg", "logo-light.svg"], ["reqkit-app-icon.svg", "favicon.svg"]])
  outputs.push([path.join(root, "site", "public", to), fs.readFileSync(path.join(root, "design", "assets", from), "utf8")]);

if (process.argv.includes("--check")) {
  const stale = outputs.filter(([file, text]) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "") !== text).map(([file]) => path.relative(root, file));
  if (stale.length) {
    console.error(`out of date: ${stale.join(", ")}; run node scripts/tokens-build.mjs`);
    process.exit(1);
  }
  console.log("tokens and copies are up to date");
} else {
  for (const [file, text] of outputs) fs.writeFileSync(file, text);
  console.log(`wrote ${outputs.map(([file]) => path.relative(root, file)).join(", ")}`);
}
