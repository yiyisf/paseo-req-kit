// Small building blocks in Paseo's theme. Every color comes from theme.colors.
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { type ReactNode, useMemo } from "react";
import { Pressable, Text, View } from "react-native";

type Theme = PluginHostProps["theme"];

export function useStyles(theme: Theme, compact: boolean) {
  return useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      body: { padding: compact ? 16 : 24, gap: compact ? 16 : 20 },
      title: { color: theme.colors.foreground, fontSize: compact ? 18 : 20, fontWeight: "600" as const },
      heading: { color: theme.colors.foregroundMuted, fontSize: 13, fontWeight: "600" as const, marginBottom: 6 },
      text: { color: theme.colors.foreground, fontSize: 14 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      danger: { color: theme.colors.statusDanger, fontSize: 13 },
      card: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: compact ? 12 : 14,
        gap: 4,
      },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      divider: { height: 1, backgroundColor: theme.colors.border },
    }),
    [theme, compact],
  );
}

export function Badge({ theme, tone, children }: { theme: Theme; tone: "warning" | "danger" | "success" | "accent" | "muted"; children: ReactNode }) {
  const color =
    tone === "warning"
      ? theme.colors.statusWarning
      : tone === "danger"
        ? theme.colors.statusDanger
        : tone === "success"
          ? theme.colors.statusSuccess
          : tone === "accent"
            ? theme.colors.accent
            : theme.colors.foregroundMuted;
  return (
    <View style={{ borderColor: color, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
      <Text style={{ color, fontSize: 12 }}>{children}</Text>
    </View>
  );
}

export function Button({
  theme,
  label,
  onPress,
  primary,
  disabled,
}: {
  theme: Theme;
  label: string;
  onPress(): void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={{
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 8,
        opacity: disabled ? 0.5 : 1,
        backgroundColor: primary ? theme.colors.accent : theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: primary ? 0 : 1,
      }}
    >
      <Text style={{ color: primary ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
}

export function Chip({ theme, label, active, onPress }: { theme: Theme; label: string; active: boolean; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 999,
        backgroundColor: active ? theme.colors.accent : theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: active ? 0 : 1,
      }}
    >
      <Text style={{ color: active ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

/** Loading, error and empty states in one place. */
export function Status({ theme, loading, error, empty }: { theme: Theme; loading?: boolean; error?: Error | null; empty?: string | null }) {
  if (error) return <Text style={{ color: theme.colors.statusDanger, fontSize: 14 }}>{error.message}</Text>;
  if (loading) return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>正在读取…</Text>;
  if (empty) return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>{empty}</Text>;
  return null;
}
