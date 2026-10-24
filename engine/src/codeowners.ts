// CODEOWNERS (1.14): who should review a change, from the repository's own CODEOWNERS file
// (GitLab and GitHub format: "pattern @user @group email", the last matching line wins; GitLab
// "[Section]" headers and "^[Optional]" are accepted). Used as the default reviewers on the code
// review page, which the person can change before submitting.
import fs from "node:fs";
import path from "node:path";

export const CODEOWNERS_FILES = ["CODEOWNERS", ".gitlab/CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];

export interface OwnerRule {
  pattern: string;
  owners: string[];
  /** The GitLab section the line is in, or null. */
  section: string | null;
}

export function readCodeowners(repo: string): { file: string; rules: OwnerRule[] } | null {
  for (const rel of CODEOWNERS_FILES) {
    const file = path.join(repo, rel);
    try {
      return { file: rel, rules: parseCodeowners(fs.readFileSync(file, "utf8")) };
    } catch {
      // Not this one.
    }
  }
  return null;
}

export function parseCodeowners(text: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  let section: string | null = null;
  let sectionOwners: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    // GitLab: "[Section]", "^[Optional section]", "[Section][2] @default-owner".
    const sec = /^\^?\[([^\]]+)\](?:\[\d+\])?\s*(.*)$/.exec(line);
    if (sec) {
      section = sec[1].trim();
      sectionOwners = sec[2].split(/\s+/).filter(Boolean);
      continue;
    }
    const parts = line.split(/\s+/);
    const pattern = parts[0].replace(/\\ /g, " ");
    const owners = parts.slice(1);
    rules.push({ pattern, owners: owners.length ? owners : sectionOwners, section });
  }
  return rules;
}

/** gitignore-like matching of a CODEOWNERS pattern against a "/"-separated path. */
export function matchesPattern(pattern: string, file: string): boolean {
  let p = pattern;
  const anchored = p.startsWith("/") || p.slice(0, -1).includes("/");
  p = p.replace(/^\//, "");
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      // "**/" any directories, "/**" everything below.
      re += p[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += p[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const prefix = anchored ? "^" : "^(?:.*/)?";
  // A directory pattern (or a name that is a directory) covers everything below it.
  const rx = new RegExp(`${prefix}${re}${dirOnly ? "/.*" : "(?:/.*)?"}$`);
  return rx.test(file);
}

/** The owners of each file (last matching rule per section), and all of them together. */
export function ownersFor(rules: OwnerRule[], files: string[]): { byFile: Record<string, string[]>; all: string[] } {
  const byFile: Record<string, string[]> = {};
  const all = new Set<string>();
  for (const file of files) {
    const winners = new Map<string | null, string[]>();
    for (const r of rules) if (matchesPattern(r.pattern, file)) winners.set(r.section, r.owners);
    const owners = [...new Set([...winners.values()].flat())];
    byFile[file] = owners;
    for (const o of owners) all.add(o);
  }
  return { byFile, all: [...all] };
}
