// One requirement in a list: title, facts, stage, what is running, what needs a person.
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Pressable, Text, View } from "react-native";
import type { Requirement } from "../shared/contracts";
import { ago, ATTENTION_LABELS, facts } from "./format";
import { Badge, useStyles } from "./ui";

export function RequirementRow({
  theme,
  layout,
  item,
  onPress,
}: Pick<PluginHostProps, "theme" | "layout"> & { item: Requirement; onPress(): void }) {
  const s = useStyles(theme, layout.compact);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={item.title} onPress={onPress} style={s.card}>
      <View style={s.row}>
        <Text style={[s.text, { fontWeight: "600", flexShrink: 1 }]}>{item.title}</Text>
        {item.attention ? (
          <Badge theme={theme} tone={item.attention === "approval" || item.attention === "business" ? "warning" : "danger"}>
            {ATTENTION_LABELS[item.attention]}
          </Badge>
        ) : item.running ? (
          <Badge theme={theme} tone="accent">
            运行中
          </Badge>
        ) : null}
        {!item.present ? (
          <Badge theme={theme} tone="muted">
            目录已不在
          </Badge>
        ) : null}
      </View>
      <Text style={s.muted}>{facts(item)}</Text>
      <Text style={s.text}>{item.stage}</Text>
      {item.current.length > 0 ? <Text style={s.muted}>正在：{item.current.map((c) => c.title).join("、")}</Text> : null}
      <Text style={s.muted}>更新于 {ago(item.updatedAt)}</Text>
    </Pressable>
  );
}
