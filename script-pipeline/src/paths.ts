import path from "node:path";

/** Compares directories the way the host filesystem does (case-insensitive on Windows and macOS). */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string) => {
    const resolved = (platform === "win32" ? path.win32 : path.posix).resolve(p).replace(/[\\/]+$/, "");
    return platform === "win32" || platform === "darwin" ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}
