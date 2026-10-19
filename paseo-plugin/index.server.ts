import type { PluginServerContext } from "@getpaseo/plugin/server";
import { configRpc, fileRpc, listRpc, modelsRpc, preferences, reviewUrlRpc, runRpc, setAgentsRpc, statsRpc, statusRpc, versionRpc } from "./shared/contracts";
import { createHandlers } from "./server/handlers";
import { kitHomeOf, reqApi } from "./server/req";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  let kitHomeSetting = "";
  let readOnly = false;
  const load = async () => {
    const state = await settings.read();
    if (state.status === "ready") {
      kitHomeSetting = state.values.kitHome;
      readOnly = state.values.readOnly;
    }
  };
  void load();
  const unsubscribe = settings.subscribe((state) => {
    if (state.status !== "ready") return;
    kitHomeSetting = state.values.kitHome;
    readOnly = state.values.readOnly;
  });
  const kitHome = () => kitHomeOf(kitHomeSetting);
  const handlers = createHandlers({
    req: reqApi(kitHome),
    kitHome,
    readOnly: async () => {
      await load();
      return readOnly;
    },
  });
  server.handle(versionRpc, () => handlers.version());
  server.handle(listRpc, () => handlers.list());
  server.handle(statusRpc, (input) => handlers.status(input));
  server.handle(fileRpc, (input) => handlers.file(input));
  server.handle(statsRpc, (input) => handlers.stats(input));
  server.handle(runRpc, (input) => handlers.run(input));
  server.handle(modelsRpc, () => handlers.models());
  server.handle(configRpc, (input) => handlers.config(input));
  server.handle(setAgentsRpc, (input) => handlers.setAgents(input));
  server.handle(reviewUrlRpc, (input) => handlers.reviewUrl(input));
  // 1.13: every few minutes, continue this machine's pipelines whose background process died
  // (req api watchdog). Deterministic, no model involved; while it runs, pipelines do not ask
  // their chats to check on them. Off when the plugin is read-only.
  const check = async () => {
    try {
      await load();
      if (readOnly) return;
      await reqApi(kitHome)(["watchdog", "--by", "plugin"], { timeoutMs: 240_000 });
    } catch {
      // req-kit missing or a check failing: the next one tries again.
    }
  };
  const first = setTimeout(() => void check(), 60_000);
  const timer = setInterval(() => void check(), 5 * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    unsubscribe();
  };
}
