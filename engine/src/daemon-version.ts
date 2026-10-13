// Prints the version of the Paseo daemon this machine uses (one line), for the
// installer's version choice: node <tsx> engine/src/daemon-version.ts [--config <file>]
// Exit code 1 and nothing on stdout when it cannot be read.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_CONFIG } from "./config.js";
import { defaultConfigPath } from "./locations.js";

interface ServerInfoClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  getLastServerInfoMessage(): { version?: string | null } | null | undefined;
}

export async function daemonVersion(daemonUrl: string, password: string | undefined, timeoutMs = 8000): Promise<string | null> {
  const internal = (await import("@getpaseo/client/internal/daemon-client").catch(() => null)) as {
    DaemonClient?: new (options: Record<string, unknown>) => ServerInfoClient;
  } | null;
  if (!internal?.DaemonClient) return null;
  const client = new internal.DaemonClient({
    url: daemonUrl,
    clientId: `req-kit-version-${process.pid}`,
    clientType: "cli",
    connectTimeoutMs: timeoutMs,
    ...(password ? { password } : {}),
  });
  try {
    await client.connect();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const version = client.getLastServerInfoMessage()?.version;
      if (version) return version;
      if (Date.now() > deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { config: { type: "string" } } });
  const file = values.config ? path.resolve(values.config) : defaultConfigPath();
  let url = DEFAULT_CONFIG.daemonUrl;
  let passwordEnv = DEFAULT_CONFIG.daemonPasswordEnv;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { daemonUrl?: string; daemonPasswordEnv?: string };
    url = raw.daemonUrl ?? url;
    passwordEnv = raw.daemonPasswordEnv ?? passwordEnv;
  } catch {
    // No machine config yet: the default address.
  }
  const version = await daemonVersion(url, process.env[passwordEnv]).catch(() => null);
  if (!version) return 1;
  console.log(version);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
