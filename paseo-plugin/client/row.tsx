// One requirement in a list: icon, title, project and feature directory, stage, what is running.
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import type { Requirement } from "../shared/contracts";
import { ago, ATTENTION_LABELS, iconOf } from "./format";
import { Badge, rk, useStyles } from "./ui";

export function RequirementRow({
  theme,
  layout,
  item,
  onPress,
}: Pick<PluginHostProps, "theme" | "layout"> & { item: Requirement; onPress(): void }) {
  const s = useStyles(theme, layout.compact);
  const c = rk(theme);
  const ic = iconOf(item);
  const iconColor =
    ic.tone === "needs" ? c.brandText : ic.tone === "running" ? c.data : ic.tone === "success" ? theme.colors.statusSuccess : ic.tone === "warning" ? theme.colors.statusWarning : ic.tone === "danger" ? theme.colors.statusDanger : theme.colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.title}
      onPress={onPress}
      style={({ pressed }: { pressed: boolean }) => [s.card, { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1 }]}
    >
      <Icon name={ic.name} size={18} color={iconColor} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={[s.text, { fontWeight: "600" }]} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={s.mono} numberOfLines={1}>
          {item.project} · {item.name}
        </Text>
        {item.current.length > 0 ? (
          <Text style={s.muted} numberOfLines={1}>
            正在：{item.current.map((x) => x.title).join("、")}
          </Text>
        ) : (
          <Text style={s.muted} numberOfLines={1}>
            {item.stage}
          </Text>
        )}
      </View>
      <View style={{ alignItems: "flex-end", gap: 4 }}>
        {item.attention ? (
          <Badge theme={theme} tone={item.attention === "interrupted" ? "danger" : item.attention === "not_completed" ? "warning" : "needs"}>
            {ATTENTION_LABELS[item.attention]}
          </Badge>
        ) : item.running ? (
          <Badge theme={theme} tone="running" icon="LoaderCircle">
            进行中
          </Badge>
        ) : !item.present ? (
          <Badge theme={theme} tone="muted">
            目录已不在
          </Badge>
        ) : null}
        <Text style={s.mono}>{ago(item.updatedAt)}</Text>
      </View>
    </Pressable>
  );
}
