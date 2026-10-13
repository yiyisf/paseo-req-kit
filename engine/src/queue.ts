// Machine-wide limit on pipelines running at once (maxConcurrentPipelines).
// A pipeline takes one of N slot files in ~/.req-kit/slots; creating a file with "wx"
// is atomic, so two pipelines starting together cannot both take the last slot.
// A slot whose process is gone is free again.

import fs from "node:fs";
import path from "node:path";
import { kitHome } from "./locations.js";
import { isAlive } from "./state.js";

export interface SlotHolder {
  pid: number;
  repo: string;
  featureDir: string;
  since: string;
}

export function slotsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(kitHome(env), "slots");
}

function readHolder(file: string): SlotHolder | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as SlotHolder;
  } catch {
    return null;
  }
}

/** Pipelines holding a slot now (dead holders are cleared on the way). */
export function slotHolders(dir: string): SlotHolder[] {
  if (!fs.existsSync(dir)) return [];
  const holders: SlotHolder[] = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const holder = readHolder(file);
    if (holder && isAlive(holder.pid)) holders.push(holder);
    else fs.rmSync(file, { force: true });
  }
  return holders;
}

/** Takes a free slot; returns a release function, or null when all `max` slots are taken. */
export function tryAcquireSlot(dir: string, max: number, holder: SlotHolder): (() => void) | null {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < max; i++) {
    const file = path.join(dir, `slot-${i}.json`);
    const current = readHolder(file);
    if (current && current.pid !== holder.pid && isAlive(current.pid)) continue;
    if (current) fs.rmSync(file, { force: true });
    try {
      fs.writeFileSync(file, JSON.stringify(holder), { flag: "wx" });
    } catch {
      continue; // taken a moment ago by another pipeline
    }
    return () => {
      if (readHolder(file)?.pid === holder.pid) fs.rmSync(file, { force: true });
    };
  }
  return null;
}
