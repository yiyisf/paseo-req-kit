// Types for the parts of bootstrap.mjs the tests use.
export function parseArgs(argv: string[]): {
  registry: string | null;
  saveRegistry: boolean;
  configure: boolean;
  paseo: boolean;
  plugin: "ask" | "yes" | "no";
  spec: string | null;
  help: boolean;
};
export function sameRegistry(a: string | null | undefined, b: string | null | undefined): boolean;
export function which(name: string, env?: NodeJS.ProcessEnv | Record<string, string>, skipRoot?: string | null): string | null;
export function startProblem(result: { status: number | null; stdout: string; stderr: string; error?: (Error & { code?: string }) | undefined }): string;
