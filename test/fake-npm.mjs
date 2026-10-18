// Stands in for npm in the installer tests (REQ_KIT_NPM). A "registry" is a directory:
//   FAKE_NPM_REGISTRY/<version>/   the package as published (a copy of the files)
//   FAKE_NPM_REGISTRY/dist-tags.json
// pack writes a .tgz that is really a pointer to the directory; install copies the package
// into <prefix>/node_modules/<name> and links this repository's dependencies next to it.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const registry = process.env.FAKE_NPM_REGISTRY;
const log = process.env.FAKE_NPM_LOG;
if (log) fs.appendFileSync(log, `${JSON.stringify(args)}\n`);
// Which registry each call used (npm_config_registry), one JSON line per call.
if (process.env.FAKE_NPM_ENV_LOG) fs.appendFileSync(process.env.FAKE_NPM_ENV_LOG, `${JSON.stringify([args[0], process.env.npm_config_registry ?? null])}\n`);
const json = args.includes("--json");
const value = (flag) => args[args.indexOf(flag) + 1];

function fail(message) {
  process.stderr.write(`npm error ${message}\n`);
  process.exit(1);
}

const [command] = args;
const globalInstall = args.includes("-g") || args.includes("--global");
// Global prefix: --prefix, else FAKE_NPM_PREFIX. Global packages go to <prefix>/lib/node_modules.
const globalPrefix = () => (args.includes("--prefix") ? value("--prefix") : process.env.FAKE_NPM_PREFIX);
// npm's own settings (only the registry): FAKE_NPM_CONFIG, a JSON file.
const configFile = process.env.FAKE_NPM_CONFIG;
const readConfig = () => (configFile && fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {});
if (command === "config" && args[1] === "get") {
  process.stdout.write(`${readConfig()[args[2]] ?? (args[2] === "registry" ? "https://registry.npmjs.org/" : "undefined")}\n`);
} else if (command === "config" && args[1] === "set") {
  if (!configFile) fail("no FAKE_NPM_CONFIG");
  fs.writeFileSync(configFile, JSON.stringify({ ...readConfig(), [args[2]]: args[3] }));
} else if (command === "exec") {
  // npm exec --yes --package=<spec> -- <bin> <args…>: installs the package into a temporary
  // prefix (with this script) and runs its bin.
  const sep = args.indexOf("--");
  const spec = args.slice(1, sep).find((a) => a.startsWith("--package="))?.slice("--package=".length);
  const [binName, ...rest] = args.slice(sep + 1);
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "fake-npx-"));
  const env = { ...process.env, npm_config_yes: "true", npm_config_package: spec, npm_command: "exec" };
  const install = spawnSync(process.execPath, [import.meta.filename, "install", "--prefix", tmp, spec], { stdio: "inherit", env });
  if (install.status !== 0) process.exit(install.status ?? 1);
  const name = fs.readdirSync(path.join(tmp, "node_modules")).find((n) => !n.startsWith("@") && n !== "tsx");
  const pkg = JSON.parse(fs.readFileSync(path.join(tmp, "node_modules", name, "package.json"), "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[binName];
  if (!bin) fail(`could not determine executable to run: ${binName}`);
  const result = spawnSync(process.execPath, [path.join(tmp, "node_modules", name, bin), ...rest], { stdio: "inherit", env });
  process.exit(result.status ?? 1);
} else if (command === "--version") {
  process.stdout.write("11.0.0-fake\n");
} else if (command === "prefix" && globalInstall) {
  if (!globalPrefix()) fail("no FAKE_NPM_PREFIX");
  process.stdout.write(`${globalPrefix()}\n`);
} else if (command === "root" && globalInstall) {
  process.stdout.write(`${path.join(globalPrefix(), "lib", "node_modules")}\n`);
} else if (command === "pack") {
  const dir = path.resolve(args[1]);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const filename = `${pkg.name}-${pkg.version}.tgz`;
  fs.writeFileSync(path.join(value("--pack-destination"), filename), JSON.stringify({ dir }));
  process.stdout.write(JSON.stringify([{ filename }]));
} else if (command === "install") {
  const prefix = globalInstall ? path.join(globalPrefix(), "lib") : value("--prefix");
  const spec = args.at(-1);
  if (spec.startsWith("@getpaseo/cli")) {
    // The Paseo CLI: a paseo command in <prefix>/bin that runs test/fake-paseo.mjs.
    const bin = path.join(globalPrefix(), "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "paseo"), `#!/bin/sh\nexec node "${path.join(ROOT, "test", "fake-paseo.mjs")}" "$@"\n`, { mode: 0o755 });
    process.exit(0);
  }
  let source;
  if (spec.endsWith(".tgz")) source = JSON.parse(fs.readFileSync(spec, "utf8")).dir;
  else {
    const version = spec.split("@").at(-1);
    source = registry && path.join(registry, version);
    if (!source || !fs.existsSync(source)) fail(`404 Not Found - ${spec}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
  const dest = path.join(prefix, "node_modules", pkg.name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(source, dest, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(source, src);
      return !rel.split(path.sep).includes("node_modules") && !rel.split(path.sep).includes(".git");
    },
  });
  for (const dep of ["tsx", "@getpaseo"]) {
    const from = path.join(ROOT, "node_modules", dep);
    const link = path.join(prefix, "node_modules", dep);
    if (fs.existsSync(from) && !fs.existsSync(link)) fs.symlinkSync(fs.realpathSync(from), link, "junction");
  }
} else if (command === "view") {
  if (!registry) fail("network unavailable");
  const [, target, field] = args;
  const versions = fs.readdirSync(registry).filter((n) => /^\d/.test(n));
  const at = target.lastIndexOf("@");
  const version = at > 0 ? target.slice(at + 1) : null;
  let out;
  if (field === "version") {
    const tags = JSON.parse(fs.readFileSync(path.join(registry, "dist-tags.json"), "utf8"));
    const resolved = versions.includes(version) ? version : tags[version];
    if (!resolved) fail(`404 No match found for version ${version}`);
    process.stdout.write(`${resolved}\n`);
    process.exit(0);
  }
  if (field === "versions") out = versions;
  else if (field === "dist-tags") out = JSON.parse(fs.readFileSync(path.join(registry, "dist-tags.json"), "utf8"));
  else if (field === "reqKit.paseo") {
    const pkg = JSON.parse(fs.readFileSync(path.join(registry, version, "package.json"), "utf8"));
    out = pkg.reqKit?.paseo;
  } else fail(`unsupported view ${field}`);
  process.stdout.write(json ? JSON.stringify(out ?? null) : String(out));
} else {
  fail(`unsupported command ${command}`);
}
