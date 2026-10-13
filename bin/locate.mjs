// Finds an installed dependency the way Node does: in <dir>/node_modules, then in each
// parent directory. A git checkout keeps dependencies in its own node_modules; an npm
// install puts them next to the package (versions/<v>/node_modules) or inside it (global).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function findDependency(fromDir, name) {
  let dir = path.resolve(fromDir);
  for (;;) {
    const candidate = path.join(dir, "node_modules", ...name.split("/"));
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** tsx's command-line entry, or null when tsx is not installed. */
export function findTsxCli(fromDir) {
  const tsx = findDependency(fromDir, "tsx");
  return tsx ? path.join(tsx, "dist", "cli.mjs") : null;
}

/**
 * How a copy of req-kit was installed, from where its files are:
 *   git       ~/tools/req-kit/versions/<v>                         (git clone, 1.x)
 *   npm       ~/tools/req-kit/versions/<v>/node_modules/<package>   (installed by the manager)
 *   manager   <npm global>/node_modules/<package>                   (npm i -g: manages the versions)
 *   checkout  anything else, e.g. a development clone
 */
export function layoutOf(root, env = process.env) {
  const parent = path.dirname(root);
  if (path.basename(parent) === "versions") return { kind: "git", versionsDir: parent };
  if (path.basename(parent) === "node_modules") {
    const prefix = path.dirname(parent);
    if (path.basename(path.dirname(prefix)) === "versions") return { kind: "npm", versionsDir: path.dirname(prefix) };
    return { kind: "manager", versionsDir: defaultVersionsDir(env) };
  }
  return { kind: "checkout", versionsDir: null };
}

export function defaultVersionsDir(env = process.env) {
  const custom = env.REQ_KIT_VERSIONS_DIR?.trim();
  return custom ? path.resolve(custom) : path.join(os.homedir(), "tools", "req-kit", "versions");
}
