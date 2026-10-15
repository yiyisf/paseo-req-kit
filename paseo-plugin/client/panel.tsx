// The panel beside a workspace: the requirements developed in it or started from it.
import { type PluginWorkspacePanelProps, useWorkspace } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import type { Requirement } from "../shared/contracts";
import { useRequirements } from "./data";
import { RequirementView } from "./detail";
import { RequirementGroups } from "./overview";
import { Button, Status, useStyles } from "./ui";

/** Same directory, ignoring a trailing separator and (on Windows) case. */
export function sameDir(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const x = norm(a);
  const y = norm(b);
  return /^[a-z]:\//i.test(x) ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export function inWorkspace(items: Requirement[], directory: string | null | undefined, workspaceId?: string | null): Requirement[] {
  return items.filter((r) => (workspaceId && r.workspaceId === workspaceId) || sameDir(r.repo, directory) || sameDir(r.sourceRepo, directory));
}

export function WorkspacePanel({ theme, layout, navigation, workspaceId }: PluginWorkspacePanelProps) {
  const s = useStyles(theme, layout.compact);
  const workspace = useWorkspace(workspaceId, (w) => ({ directory: w.directory, name: w.name }));
  const query = useRequirements();
  const [picked, setPicked] = useState<Pick<Requirement, "repo" | "featureDir"> | null>(null);
  const items = inWorkspace(query.data ?? [], workspace?.directory, workspaceId);
  const only = items.length === 1 ? items[0] : null;
  const shown = picked ?? only;
  return (
    <View style={s.screen}>
      <ScrollView contentContainerStyle={s.body}>
        <Status
          theme={theme}
          loading={query.isPending}
          error={query.error}
          empty={query.data && items.length === 0 ? `${workspace?.name ?? "这个工作区"}还没有需求。在对话中用 /req 开始一个。` : null}
        />
        {shown ? (
          <>
            {picked && !only ? <Button theme={theme} label="返回列表" onPress={() => setPicked(null)} /> : null}
            <RequirementView theme={theme} layout={layout} navigation={navigation} repo={shown.repo} featureDir={shown.featureDir} />
          </>
        ) : items.length > 1 ? (
          <>
            <Text style={s.muted}>这个工作区有 {items.length} 个需求</Text>
            <RequirementGroups theme={theme} layout={layout} items={items} open={(item) => setPicked(item)} />
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
