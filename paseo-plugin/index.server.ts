import type { PluginServerContext } from "@getpaseo/plugin/server";
import { fileRpc, listRpc, modelsRpc, preferences, runRpc, setAgentsRpc, statsRpc, statusRpc, versionRpc } from "./shared/contracts";
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
  server.handle(setAgentsRpc, (input) => handlers.setAgents(input));
  return () => {
    unsubscribe();
  };
}
