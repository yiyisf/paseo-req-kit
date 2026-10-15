// The daemon side: each RPC is one `req api` call. Management actions are refused here too
// when the plugin is set to read-only, not only hidden in the app.
import type { RpcInput } from "@getpaseo/plugin";
import type { fileRpc, KitInfo, Requirement, RequirementDetail, runRpc, statsRpc, StatsSummary, statusRpc } from "../shared/contracts";
import { coalesce, type ReqRunner } from "./req";

export interface Handlers {
  version(): Promise<KitInfo>;
  list(): Promise<Requirement[]>;
  status(input: RpcInput<typeof statusRpc>): Promise<RequirementDetail>;
  file(input: RpcInput<typeof fileRpc>): Promise<{ file: string; size: number; truncated: boolean; content: string }>;
  stats(input: RpcInput<typeof statsRpc>): Promise<StatsSummary>;
  run(input: RpcInput<typeof runRpc>): Promise<{ ok: boolean; message: string }>;
}

export function createHandlers(input: { req: ReqRunner; kitHome: () => string; readOnly: () => Promise<boolean> }): Handlers {
  const { req } = input;
  // Every open screen polls the list; one `req api list` serves them all for a moment.
  const list = coalesce(2_000, () => req(["list", "--all"]) as Promise<Requirement[]>);
  return {
    async version() {
      const info = (await req(["version"])) as Omit<KitInfo, "kitHome">;
      return { ...info, kitHome: input.kitHome() };
    },
    list,
    async status({ repo, featureDir }) {
      return (await req(["status", featureDir, "--repo", repo])) as RequirementDetail;
    },
    async file({ repo, featureDir, file }) {
      return (await req(["file", featureDir, file, "--repo", repo])) as { file: string; size: number; truncated: boolean; content: string };
    },
    async stats({ since, month }) {
      const args = ["stats"];
      if (month) args.push("--month", month);
      else if (since) args.push("--since", since);
      return (await req(args)) as StatsSummary;
    },
    async run({ action, repo, featureDir, verifyEnv }) {
      if (await input.readOnly()) return { ok: false, message: "插件设置为只读：不能在这里操作需求。可以在插件设置中关闭只读，或在终端用 req 命令。" };
      const extra = action === "verify" && verifyEnv ? ["--verify-env", verifyEnv] : [];
      const result = (await req(["run", action, featureDir, "--repo", repo, ...extra], { timeoutMs: 200_000 })) as { ok: boolean; message: string };
      return { ok: result.ok, message: result.message };
    },
  };
}
