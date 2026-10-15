// Settings → Plugins → req-kit: what the plugin found, read-only mode, refresh interval.
import { type PluginSurfaceProps, type SettingsState, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
import { preferences } from "../shared/contracts";
import { useKitInfo } from "./data";

type Ready = Extract<SettingsState<typeof preferences.schema>, { status: "ready" }>;

const REFRESH = [
  { label: "5 秒", value: "5" },
  { label: "10 秒", value: "10" },
  { label: "30 秒", value: "30" },
  { label: "1 分钟", value: "60" },
];

function Controls({ settings, theme }: { settings: Ready; theme: PluginSurfaceProps["theme"] }) {
  const [kitHome, setKitHome] = useState(settings.values.kitHome);
  const info = useKitInfo();
  return (
    <>
      <SettingsSection title="req-kit">
        <SettingsCard>
          {info.data ? (
            <>
              <SettingsRow label="版本" hint={info.data.kitRoot}>
                <Text style={{ color: theme.colors.foreground }}>{info.data.kitVersion}</Text>
              </SettingsRow>
              <SettingsRow label="支持的 Paseo" hint={`本机配置目录：${info.data.kitHome}`}>
                <Text style={{ color: theme.colors.foreground }}>{info.data.paseo ?? "-"}</Text>
              </SettingsRow>
            </>
          ) : (
            <SettingsRow label="状态" error={info.error?.message ?? undefined} hint={info.isPending ? "正在读取…" : undefined} />
          )}
          <SettingsInput
            label="req-kit 的本机配置目录"
            hint="通常不用填：默认是运行 Paseo 的用户的 ~/.req-kit。设置了 REQ_KIT_HOME 时填那个目录。"
            initialValue={settings.values.kitHome}
            placeholder="~/.req-kit"
            onChangeText={setKitHome}
            disabled={settings.saving}
            error={settings.saveError ?? undefined}
          />
          <SettingsAction
            label="保存配置目录"
            actionLabel="保存"
            disabled={settings.saving || kitHome === settings.values.kitHome}
            onPress={() => void settings.save({ ...settings.values, kitHome: kitHome.trim() }, settings.revision).then(() => info.refetch())}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="显示与操作">
        <SettingsCard>
          <SettingsSwitch
            label="只读"
            hint="只显示需求和文档，不提供确认方案、停止、继续、开始测试验证。能连上这台 daemon 的人都能看到这个插件。"
            value={settings.values.readOnly}
            disabled={settings.saving}
            onValueChange={(readOnly) => void settings.save({ ...settings.values, readOnly }, settings.revision)}
          />
          <SettingsSelect
            label="刷新间隔"
            value={String(settings.values.refreshSeconds)}
            options={REFRESH}
            disabled={settings.saving}
            onValueChange={(v) => void settings.save({ ...settings.values, refreshSeconds: Number(v) }, settings.revision)}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  if (settings.status === "loading") return <Text style={{ color: theme.colors.foregroundMuted }}>正在读取…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="设置">
        <SettingsCard>
          <SettingsRow label="设置读取失败" error={settings.error} />
          <SettingsAction label="恢复默认设置" actionLabel="恢复" onPress={() => void settings.reset()} />
        </SettingsCard>
      </SettingsSection>
    );
  }
  return <Controls settings={settings} theme={theme} />;
}
