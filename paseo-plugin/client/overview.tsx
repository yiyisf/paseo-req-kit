// The overview: every requirement on this machine, grouped by what it needs.
import type { PluginOpenScreenInput, PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { Requirement } from "../shared/contracts";
import { useRequirements } from "./data";
import { type Group, GROUP_LABELS, groupOf } from "./format";
import { Inbox } from "./inbox";
import { RequirementRow } from "./row";
import { BrandHeader, Button, Chip, Eyebrow, Status, useStyles } from "./ui";

export const ORDER: Group[] = ["attention", "running", "verify", "done", "other"];

/** Uppercase mono group names (design/guidelines/plugin.md); the Chinese label follows. */
const EYEBROW: Record<Group, string> = { attention: "NEEDS YOU", running: "IN PROGRESS", verify: "READY TO TEST", done: "DONE", other: "OTHERS" };

/** Opens a requirement's detail screen. */
export type OpenRequirement = (item: Pick<Requirement, "repo" | "featureDir" | "title">) => void;

export function RequirementGroups({
  theme,
  layout,
  items,
  open,
  skip = [],
}: Pick<PluginScreenProps, "theme" | "layout"> & { items: Requirement[]; open: OpenRequirement; skip?: Group[] }) {
  const s = useStyles(theme, layout.compact);
  const [showOther, setShowOther] = useState(false);
  const groups = useMemo(() => {
    const map = new Map<Group, Requirement[]>();
    for (const item of items) map.set(groupOf(item), [...(map.get(groupOf(item)) ?? []), item]);
    return map;
  }, [items]);
  return (
    <View style={{ gap: 20 }}>
      {ORDER.filter((g) => groups.has(g) && !skip.includes(g)).map((g) => (
        <View key={g} style={{ gap: 8 }}>
          <Eyebrow
            theme={theme}
            accent={g === "attention"}
            right={g === "other" ? <Button theme={theme} label={showOther ? "收起" : "展开"} onPress={() => setShowOther((v) => !v)} /> : <Text style={s.muted}>{GROUP_LABELS[g]}</Text>}
          >
            {EYEBROW[g]} · {groups.get(g)!.length}
          </Eyebrow>
          {g === "other" && !showOther
            ? null
            : groups.get(g)!.map((item) => <RequirementRow key={item.key} theme={theme} layout={layout} item={item} onPress={() => open(item)} />)}
        </View>
      ))}
    </View>
  );
}

/** Screens open other screens through the client context; index.client.tsx passes it in. */
export type ScreenOpener = (input: PluginOpenScreenInput) => void;

export function requirementOpener(openScreen: ScreenOpener): OpenRequirement {
  return (item) => openScreen({ screenId: "requirement", params: { repo: item.repo, featureDir: item.featureDir, title: item.title } });
}

export function OverviewScreen(props: PluginScreenProps & { openScreen: ScreenOpener }) {
  const { theme, layout } = props;
  const s = useStyles(theme, layout.compact);
  const query = useRequirements();
  const [project, setProject] = useState<string | null>(null);
  const items = query.data ?? [];
  const projects = useMemo(() => [...new Set(items.map((i) => i.project))].sort(), [items]);
  const shown = project ? items.filter((i) => i.project === project) : items;
  const open = requirementOpener(props.openScreen);
  return (
    <View style={s.screen}>
      <ScrollView contentContainerStyle={s.body}>
        <BrandHeader
          theme={theme}
          page="需求"
          right={
            <View style={s.row}>
              <Button theme={theme} icon="ChartColumn" label="使用统计" onPress={() => props.openScreen({ screenId: "stats" })} />
              <Button theme={theme} icon="Settings2" label="配置" onPress={() => props.openScreen({ screenId: "config" })} />
            </View>
          }
        />
        {projects.length > 1 ? (
          <View style={s.row}>
            <Chip theme={theme} label="全部项目" active={project === null} onPress={() => setProject(null)} />
            {projects.map((p) => (
              <Chip key={p} theme={theme} label={p} active={project === p} onPress={() => setProject(p)} />
            ))}
          </View>
        ) : null}
        <Status
          theme={theme}
          loading={query.isPending}
          error={query.error}
          empty={query.data && items.length === 0 ? "这台机器上还没有记录任何需求。在 Paseo 对话中用 /req 开始一个；1.9 之前运行过的需求，在项目目录运行 req index --rebuild。" : null}
        />
        {query.data && items.length > 0 ? <Inbox theme={theme} layout={layout} items={shown} open={open} openAgent={props.navigation ? (agentId) => props.navigation!.openAgent({ agentId }) : undefined} /> : null}
        <RequirementGroups theme={theme} layout={layout} items={shown} open={open} skip={["attention"]} />
      </ScrollView>
    </View>
  );
}
