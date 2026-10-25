// Small building blocks. Surfaces, text, borders and status colors come from Paseo's theme
// (theme.colors), so the plugin sits well in Paseo's light, dark and phone layouts; req-kit's own
// accents (lime for "you decide", indigo for AI, cyan for running) come from design/ through
// shared/rk-colors.ts. See design/guidelines/plugin.md.
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { RK_COLORS, type RkColors } from "../shared/rk-colors";

type Theme = PluginHostProps["theme"];

const MONO = "ui-monospace, Menlo, Consolas, monospace";

/** Whether Paseo is in a dark theme: from the brightness of its page background. */
export function isDark(theme: Theme): boolean {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(theme.colors.surface0.trim());
  if (!m) return true;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.45;
}

/** req-kit's accent colors for the current Paseo theme. */
export function rk(theme: Theme): RkColors {
  return isDark(theme) ? RK_COLORS.dark : (RK_COLORS.light as unknown as RkColors);
}

export function useStyles(theme: Theme, compact: boolean) {
  return useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      body: { padding: compact ? 16 : 24, gap: compact ? 16 : 20 },
      title: { color: theme.colors.foreground, fontSize: compact ? 18 : 20, fontWeight: "600" as const },
      heading: { color: theme.colors.foregroundMuted, fontSize: 13, fontWeight: "600" as const, marginBottom: 6 },
      text: { color: theme.colors.foreground, fontSize: 14, lineHeight: 22 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 },
      mono: { color: theme.colors.foregroundMuted, fontSize: 12, fontFamily: MONO },
      danger: { color: theme.colors.statusDanger, fontSize: 13 },
      eyebrow: { color: theme.colors.foregroundMuted, fontSize: 12, fontFamily: MONO, letterSpacing: 1.9, fontWeight: "500" as const },
      card: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 14,
        padding: compact ? 12 : 16,
        gap: 6,
      },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      divider: { height: 1, backgroundColor: theme.colors.border },
    }),
    [theme, compact],
  );
}

export type Tone = "warning" | "danger" | "success" | "accent" | "running" | "needs" | "ai" | "muted";

/** A status badge: color + (optional) Lucide icon + words. "accent" is an older name for "running". */
export function Badge({ theme, tone, icon, children }: { theme: Theme; tone: Tone; icon?: string; children: ReactNode }) {
  const c = rk(theme);
  const [fg, bg] =
    tone === "warning"
      ? [theme.colors.statusWarning, c.warningTint]
      : tone === "danger"
        ? [theme.colors.statusDanger, c.failedTint]
        : tone === "success"
          ? [theme.colors.statusSuccess, c.successTint]
          : tone === "running" || tone === "accent"
            ? [c.data, c.dataTint]
            : tone === "needs"
              ? [c.brandText, c.brandTint]
              : tone === "ai"
                ? [c.ai, c.aiTint]
                : [theme.colors.foregroundMuted, theme.colors.surface2];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: bg }}>
      {icon ? <Icon name={icon} size={13} color={fg} /> : null}
      <Text style={{ color: fg, fontSize: 12, fontWeight: "600" }}>{children}</Text>
    </View>
  );
}

/**
 * A button. `primary` is req-kit's lime: the one decision this view is asking for (one per card or
 * screen). Others take Paseo's surfaces.
 */
export function Button({
  theme,
  label,
  onPress,
  primary,
  disabled,
  icon,
}: {
  theme: Theme;
  label: string;
  onPress(): void;
  primary?: boolean;
  disabled?: boolean;
  icon?: string;
}) {
  const c = rk(theme);
  const fg = primary ? c.onBrand : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }: { pressed: boolean }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 10,
        opacity: disabled ? 0.5 : 1,
        backgroundColor: primary ? (pressed ? c.brand400 : c.brand500) : pressed ? theme.colors.surface1 : theme.colors.surface2,
        borderColor: primary ? c.brandEdge : theme.colors.border,
        borderWidth: 1,
      })}
    >
      {icon ? <Icon name={icon} size={16} color={fg} /> : null}
      <Text style={{ color: fg, fontSize: 14, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

/** A filter chip; the selected one carries req-kit's lime. */
export function Chip({ theme, label, active, onPress }: { theme: Theme; label: string; active: boolean; onPress(): void }) {
  const c = rk(theme);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={{
        paddingHorizontal: 12,
        paddingVertical: 5,
        borderRadius: 999,
        backgroundColor: active ? c.brandTint : theme.colors.surface1,
        borderColor: active ? c.brandEdge : theme.colors.border,
        borderWidth: 1,
      }}
    >
      <Text style={{ color: active ? c.brandText : theme.colors.foreground, fontSize: 13, fontWeight: active ? "600" : "400" }}>{label}</Text>
    </Pressable>
  );
}

/** An uppercase mono label above a group, e.g. NEEDS YOU · 2. */
export function Eyebrow({ theme, children, accent, right }: { theme: Theme; children: ReactNode; accent?: boolean; right?: ReactNode }) {
  const c = rk(theme);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
      <Text style={{ color: accent ? c.brandText : theme.colors.foregroundMuted, fontSize: 12, fontFamily: MONO, letterSpacing: 1.9, fontWeight: "500" }}>{children}</Text>
      {right ?? null}
    </View>
  );
}

/** The req-kit mark (a check-shaped pipeline ending in a lit node), drawn with views. */
export function Mark({ theme, size = 20 }: { theme: Theme; size?: number }) {
  const c = rk(theme);
  const k = size / 100;
  const bar = (x1: number, y1: number, x2: number, y2: number) => {
    const len = Math.hypot(x2 - x1, y2 - y1);
    const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    return (
      <View
        style={{
          position: "absolute",
          left: ((x1 + x2) / 2 - len / 2) * k,
          top: ((y1 + y2) / 2) * k - 5 * k,
          width: len * k,
          height: 10 * k,
          borderRadius: 5 * k,
          backgroundColor: c.brandEdge,
          transform: [{ rotate: `${angle}deg` }],
        }}
      />
    );
  };
  const node = (x: number, y: number, r: number, filled: boolean) => (
    <View
      style={{
        position: "absolute",
        left: (x - r) * k,
        top: (y - r) * k,
        width: 2 * r * k,
        height: 2 * r * k,
        borderRadius: r * k,
        backgroundColor: filled ? c.brandEdge : theme.colors.surface0,
        borderColor: c.brandEdge,
        borderWidth: filled ? 0 : Math.max(1, 6 * k),
      }}
    />
  );
  return (
    <View style={{ width: size, height: size }}>
      {bar(16, 54, 40, 77)}
      {bar(40, 77, 82, 30)}
      {node(16, 54, 9, false)}
      {node(40, 77, 9, false)}
      {node(82, 30, 13, true)}
    </View>
  );
}

/** The mark and the wordmark "req-kit" (its hyphen lime), and an optional page name. */
export function BrandHeader({ theme, page, right }: { theme: Theme; page?: string; right?: ReactNode }) {
  const c = rk(theme);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <Mark theme={theme} size={20} />
      <Text style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "800", letterSpacing: -0.3 }}>
        req<Text style={{ color: c.brandEdge }}>-</Text>kit
      </Text>
      {page ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 15, fontWeight: "600" }}>{page}</Text> : null}
      <View style={{ flex: 1 }} />
      {right ?? null}
    </View>
  );
}

export type TrackState = "done" | "now" | "needs" | "todo";

/** The step track: where a requirement is (design/components/StepTrack.md). */
export function StepTrack({ theme, steps }: { theme: Theme; steps: Array<{ label: string; who: string; state: TrackState }> }) {
  const c = rk(theme);
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start" }} accessibilityLabel={`进度：${steps.map((s) => `${s.label}${s.state === "done" ? "已完成" : s.state === "now" ? "进行中" : s.state === "needs" ? "等你" : ""}`).join("，")}`}>
      {steps.map((st, i) => {
        const reached = st.state !== "todo";
        const dot =
          st.state === "done"
            ? { bg: c.successTint, border: theme.colors.statusSuccess, fg: theme.colors.statusSuccess }
            : st.state === "now"
              ? { bg: c.dataTint, border: c.data, fg: c.data }
              : st.state === "needs"
                ? { bg: c.brand500, border: c.brandEdge, fg: c.onBrand }
                : { bg: theme.colors.surface1, border: theme.colors.border, fg: theme.colors.foregroundMuted };
        return (
          <View key={st.label} style={{ flex: 1, alignItems: "center", gap: 4, minWidth: 48 }}>
            <View style={{ flexDirection: "row", alignItems: "center", alignSelf: "stretch" }}>
              <View style={{ flex: 1, height: 2, backgroundColor: i === 0 ? "transparent" : reached ? theme.colors.statusSuccess : theme.colors.border }} />
              <View style={{ width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: dot.bg, borderColor: dot.border, borderWidth: 1.5 }}>
                {st.state === "done" ? <Icon name="Check" size={13} color={dot.fg} /> : <Text style={{ color: dot.fg, fontSize: 11, fontWeight: "700", fontFamily: MONO }}>{i + 1}</Text>}
              </View>
              <View style={{ flex: 1, height: 2, backgroundColor: i === steps.length - 1 ? "transparent" : steps[i + 1].state !== "todo" ? theme.colors.statusSuccess : theme.colors.border }} />
            </View>
            <Text style={{ color: st.state === "needs" ? c.brandText : theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>{st.label}</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{st.who}</Text>
          </View>
        );
      })}
    </View>
  );
}

/** The square icon block at the start of an "等你处理" card. */
export function AttentionIcon({ theme, icon, tone = "needs" }: { theme: Theme; icon: string; tone?: "needs" | "danger" | "muted" }) {
  const c = rk(theme);
  const [fg, bg] = tone === "danger" ? [theme.colors.statusDanger, c.failedTint] : tone === "muted" ? [theme.colors.foregroundMuted, theme.colors.surface2] : [c.brandText, c.brandTint];
  return (
    <View style={{ width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: bg }}>
      <Icon name={icon} size={18} color={fg} />
    </View>
  );
}

/** Loading, error and empty states in one place. */
export function Status({ theme, loading, error, empty }: { theme: Theme; loading?: boolean; error?: Error | null; empty?: string | null }) {
  if (error) return <Text style={{ color: theme.colors.statusDanger, fontSize: 14 }}>{error.message}</Text>;
  if (loading) return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>正在读取…</Text>;
  if (empty) return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>{empty}</Text>;
  return null;
}
