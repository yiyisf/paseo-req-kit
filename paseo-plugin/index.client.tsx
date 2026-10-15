import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { RequirementScreen } from "./client/detail";
import { contributeLive } from "./client/live";
import { OverviewScreen } from "./client/overview";
import { WorkspacePanel } from "./client/panel";
import { SettingsScreen } from "./client/settings";
import { RequirementsItem } from "./client/sidebar";
import { StatsScreen } from "./client/stats";

export default function contribute(client: PluginClientContext) {
  const openScreen = (input: { screenId: string; params?: Record<string, string> }) => client.openScreen(input);
  const Overview = (props: PluginScreenProps) => <OverviewScreen {...props} openScreen={openScreen} />;

  client.addScreen({ id: "overview", title: "需求", Component: Overview });
  client.addScreen({ id: "requirement", title: (params) => params.title || params.name || "需求", Component: RequirementScreen });
  client.addScreen({ id: "stats", title: "需求统计", Component: StatsScreen });
  client.addSidebarHeaderItem({ id: "requirements", title: "需求（req-kit）", Component: RequirementsItem });
  client.addWorkspacePanel({
    id: "requirements",
    title: "需求",
    icon: "ClipboardList",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: WorkspacePanel,
  });
  client.addSettingsScreen({ id: "preferences", title: "req-kit", icon: "ClipboardList", Component: SettingsScreen });
  client.addCommandCenterItem({
    id: "open-overview",
    title: "需求总览（req-kit）",
    icon: "ClipboardList",
    keywords: ["req", "requirement", "需求", "流水线"],
    context: "global",
    onSelect: ({ openScreen: open }) => open({ screenId: "overview" }),
  });
  client.addCommandCenterItem({
    id: "open-stats",
    title: "需求统计（req-kit）",
    icon: "ChartColumn",
    keywords: ["req", "stats", "统计", "用量"],
    context: "global",
    onSelect: ({ openScreen: open }) => open({ screenId: "stats" }),
  });
  client.addCommandCenterItem({
    id: "open-panel",
    title: "这个工作区的需求（req-kit）",
    icon: "ClipboardList",
    keywords: ["req", "需求"],
    context: "workspace",
    onSelect: ({ openPanel }) => openPanel("requirements"),
  });
  return contributeLive(client);
}
