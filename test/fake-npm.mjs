// Stands in for npm in the installer tests (REQ_KIT_NPM). A "registry" is a directory:
//   FAKE_NPM_REGISTRY/<version>/   the package as published (a copy of the files)
//   FAKE_NPM_REGISTRY/dist-tags.json
// pack writes a .tgz that is really a pointer to the directory; install copies the package
// into <prefix>/node_modules/<name> and links this repository's dependencies next to it.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const registry = process.env.FAKE_NPM_REGISTRY;
const log = process.env.FAKE_NPM_LOG;
if (log) fs.appendFileSync(log, `${JSON.stringify(args)}\n`);
const json = args.includes("--json");
const value = (flag) => args[args.indexOf(flag) + 1];

function fail(message) {
  process.stderr.write(`npm error ${message}\n`);
  process.exit(1);
}

const [command] = args;
if (command === "pack") {
  const dir = path.resolve(args[1]);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const filename = `${pkg.name}-${pkg.version}.tgz`;
  fs.writeFileSync(path.join(value("--pack-destination"), filename), JSON.stringify({ dir }));
  process.stdout.write(JSON.stringify([{ filename }]));
} else if (command === "install") {
  const prefix = value("--prefix");
  const spec = args.at(-1);
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
  fs.cpSync(source, dest, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(source, src);
      return !rel.split(path.sep).includes("node_modules") && !rel.split(path.sep).includes(".git");
    },
  });
  for (const dep of ["tsx", "@getpaseo"]) {
    const from = path.join(ROOT, "node_modules", dep);
    if (fs.existsSync(from)) fs.symlinkSync(fs.realpathSync(from), path.join(prefix, "node_modules", dep), "junction");
  }
} else if (command === "view") {
  if (!registry) fail("network unavailable");
  const [, target, field] = args;
  const versions = fs.readdirSync(registry).filter((n) => /^\d/.test(n));
  const at = target.lastIndexOf("@");
  const version = at > 0 ? target.slice(at + 1) : null;
  let out;
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
