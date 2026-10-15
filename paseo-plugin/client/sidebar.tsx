// The "需求" row in the sidebar, with how many requirements need a person.
import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { useRequirements } from "./data";

export function RequirementsItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const query = useRequirements();
  const waiting = (query.data ?? []).filter((r) => r.attention).length;
  return (
    <SidebarRow
      icon="ClipboardList"
      label="需求"
      active={currentScreen !== null}
      onPress={() => openScreen({ screenId: "overview" })}
      trailing={
        waiting > 0 ? (
          <View style={{ backgroundColor: theme.colors.statusWarning, borderRadius: 999, minWidth: 18, paddingHorizontal: 5, alignItems: "center" }}>
            <Text accessibilityLabel={`${waiting} 个需求需要处理`} style={{ color: theme.colors.surface0, fontSize: 11, fontWeight: "600" }}>
              {waiting}
            </Text>
          </View>
        ) : undefined
      }
    />
  );
}
