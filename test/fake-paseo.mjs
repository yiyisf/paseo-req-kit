// Stands in for the paseo command in the installer tests. Records each call in FAKE_PASEO_LOG
// and keeps the daemon configuration in FAKE_PASEO_CONFIG (a JSON file of dotted keys).
import fs from "node:fs";

const args = process.argv.slice(2);
const log = process.env.FAKE_PASEO_LOG;
if (log) fs.appendFileSync(log, `${JSON.stringify(args)}\n`);
const configFile = process.env.FAKE_PASEO_CONFIG;
const config = () => (configFile && fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {});

if (args[0] === "--version") {
  process.stdout.write(`${process.env.FAKE_PASEO_VERSION ?? "0.11.2"}\n`);
} else if (args[0] === "daemon" && args[1] === "config" && args[2] === "get") {
  process.stdout.write(`${JSON.stringify(config()[args[3]] ?? null)}\n`);
} else if (args[0] === "daemon" && args[1] === "config" && args[2] === "set") {
  fs.writeFileSync(configFile, JSON.stringify({ ...config(), [args[3]]: JSON.parse(args[4]) }));
} else if (args[0] === "daemon" && args[1] === "start") {
  process.stdout.write("daemon started\n");
} else {
  process.stderr.write(`fake paseo: unsupported ${args.join(" ")}\n`);
  process.exit(1);
}
