// Data hooks: every read is an RPC to the daemon side (req api), cached by React Query.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { fileRpc, listRpc, preferences, runRpc, statsRpc, statusRpc, versionRpc, type Action } from "../shared/contracts";

export function usePreferences(): { readOnly: boolean; refreshMs: number } {
  const settings = useSettings(preferences);
  if (settings.status !== "ready") return { readOnly: true, refreshMs: 10_000 };
  return { readOnly: settings.values.readOnly, refreshMs: settings.values.refreshSeconds * 1000 };
}

export function useRequirements() {
  const list = useRpc(listRpc);
  const { refreshMs } = usePreferences();
  return useQuery({ queryKey: ["req", "list"], queryFn: () => list({}), refetchInterval: refreshMs });
}

export function useRequirement(repo: string, featureDir: string) {
  const status = useRpc(statusRpc);
  const { refreshMs } = usePreferences();
  return useQuery({
    queryKey: ["req", "status", repo, featureDir],
    queryFn: () => status({ repo, featureDir }),
    refetchInterval: refreshMs,
    enabled: Boolean(repo && featureDir),
  });
}

export function useDocument(repo: string, featureDir: string, file: string | null) {
  const read = useRpc(fileRpc);
  return useQuery({
    queryKey: ["req", "file", repo, featureDir, file],
    queryFn: () => read({ repo, featureDir, file: file ?? "" }),
    enabled: Boolean(file),
  });
}

export function useStats(period: { since?: string; month?: string }) {
  const stats = useRpc(statsRpc);
  return useQuery({ queryKey: ["req", "stats", period.since ?? "", period.month ?? ""], queryFn: () => stats(period) });
}

export function useKitInfo() {
  const version = useRpc(versionRpc);
  return useQuery({ queryKey: ["req", "version"], queryFn: () => version({}), retry: false });
}

export function useAction() {
  const run = useRpc(runRpc);
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (input: { action: Action; repo: string; featureDir: string; verifyEnv?: "local" | "deployed" }) => run(input),
    onSettled: () => queries.invalidateQueries({ queryKey: ["req"] }),
  });
}
