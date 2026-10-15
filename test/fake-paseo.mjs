// Stands in for the paseo command in the installer and plugin tests. Records each call in
// FAKE_PASEO_LOG and keeps its state (daemon configuration, installed plugins) in the JSON
// file FAKE_PASEO_CONFIG.
import fs from "node:fs";

const args = process.argv.slice(2).filter((a) => a !== "--json");
const log = process.env.FAKE_PASEO_LOG;
if (log) fs.appendFileSync(log, `${JSON.stringify(args)}\n`);
const file = process.env.FAKE_PASEO_CONFIG;
const read = () => (file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {});
const write = (state) => fs.writeFileSync(file, JSON.stringify(state));
const out = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
const [a, b, c, d, e] = args;

if (a === "--version") {
  process.stdout.write(`${process.env.FAKE_PASEO_VERSION ?? "0.11.2"}\n`);
} else if (a === "daemon" && b === "config" && c === "get") {
  // Like paseo: {"source", "path", "set", "value"}, pretty-printed.
  const value = read()[d];
  out({ source: "configured", path: d, set: value !== undefined, value: value ?? null });
} else if (a === "daemon" && b === "config" && c === "set") {
  write({ ...read(), [d]: JSON.parse(e) });
  out({ action: "saved", applied: true });
} else if (a === "daemon" && b === "start") {
  process.stdout.write("daemon started\n");
} else if (a === "plugin" && b === "ls") {
  const state = read();
  out((state.plugins ?? []).map((p) => ({ ...p, status: state.pluginsEnabled ? p.status : "disabled" })));
} else if (a === "plugin" && (b === "install" || b === "add")) {
  const state = read();
  if (!fs.existsSync(`${c}/paseo-plugin.json`)) fail(`No paseo-plugin.json in ${c}`);
  const id = JSON.parse(fs.readFileSync(`${c}/paseo-plugin.json`, "utf8")).id;
  if ((state.plugins ?? []).some((p) => p.id === id)) fail(`Plugin already configured: ${id}`);
  write({ ...state, plugins: [...(state.plugins ?? []), { id, status: "running", enabled: true, path: c }] });
  out({ id, status: "running" });
} else if (a === "plugin" && (b === "reload" || b === "remove")) {
  const state = read();
  if (!(state.plugins ?? []).some((p) => p.id === c)) fail(`Plugin is not configured: ${c}`);
  if (b === "remove") write({ ...state, plugins: state.plugins.filter((p) => p.id !== c) });
  out({ id: c, status: b === "remove" ? "disabled" : "running" });
} else {
  fail(`fake paseo: unsupported ${args.join(" ")}`);
}
