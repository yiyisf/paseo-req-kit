// Types for the parts of req-docs.mjs the tests use.
import type { Server } from "node:http";
export function siteDir(root?: string, env?: NodeJS.ProcessEnv | Record<string, string>): string | null;
export function resolveFile(dir: string, urlPath: string): string | null;
export function createServer(dir: string): Server;
