// Settings → Plugins → req-kit → 模型 (1.12): pick builder, reviewer and the fallback model from what
// this daemon offers, and write them to req-kit's machine config — the same as `req configure`.
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import type { AgentChoiceData, AgentProfileData } from "../shared/contracts";
import { useModels, useSetAgents } from "./data";

const NONE = "none";

/** The choice a saved profile corresponds to; a profile Paseo no longer offers keeps its own entry. */
function idOf(profile: AgentProfileData | null | undefined, choices: AgentChoiceData[]): string {
  if (!profile) return NONE;
  if (profile.paseoProfile) return `paseo:${profile.paseoProfile}`;
  const found = choices.find((c) => !c.profile.paseoProfile && c.profile.provider === profile.provider);
  return found ? found.id : `saved:${profile.provider ?? ""}`;
}

type Role = "builder" | "reviewer" | "fallback";

const ROLES: Array<{ role: Role; label: string; hint: string }> = [
  { role: "builder", label: "builder", hint: "方案设计、写代码、修复、写报告" },
  { role: "reviewer", label: "reviewer", hint: "方案审核、代码评审、功能验证。和 builder 用不同厂商的模型，更容易发现问题" },
  { role: "fallback", label: "备用模型", hint: "主模型一直限流、额度用完或报错时，换它把这一步做完，而不是停下等人" },
];

export function ModelSettings({ theme, readOnly }: { theme: PluginSurfaceProps["theme"]; readOnly: boolean }) {
  const models = useModels();
  const save = useSetAgents();
  const data = models.data;
  const choices = data?.choices ?? [];
  const [picked, setPicked] = useState<Record<Role, string>>({ builder: NONE, reviewer: NONE, fallback: NONE });
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setPicked({
      builder: idOf(data.current?.builder, choices),
      reviewer: idOf(data.current?.reviewer, choices),
      fallback: idOf(data.current?.fallback ?? null, choices),
    });
  }, [data]);

  if (!data) {
    return (
      <SettingsSection title="模型">
        <SettingsCard>
          <SettingsRow label="可用的 agent" error={models.error?.message ?? undefined} hint={models.isPending ? "正在向 Paseo 读取已登录的 agent 和模型…" : undefined} />
        </SettingsCard>
      </SettingsSection>
    );
  }

  const saved = (role: Role): AgentProfileData | null => (role === "fallback" ? (data.current?.fallback ?? null) : (data.current?.[role] ?? null));
  const profileOf = (role: Role, id: string): AgentProfileData | null => {
    if (id === NONE) return null;
    if (id.startsWith("saved:")) return saved(role);
    return choices.find((c) => c.id === id)?.profile ?? null;
  };
  const optionsFor = (role: Role) => {
    const list = choices.map((c) => ({ label: c.label, value: c.id }));
    const current = picked[role];
    if (current.startsWith("saved:")) list.unshift({ label: `现在的设置：${current.slice(6)}（Paseo 中没有找到）`, value: current });
    if (role === "fallback" || current === NONE) list.unshift({ label: role === "fallback" ? "不用备用模型" : "（未设置）", value: NONE });
    return list;
  };
  const builder = profileOf("builder", picked.builder);
  const reviewer = profileOf("reviewer", picked.reviewer);
  const changed = ROLES.some(({ role }) => picked[role] !== idOf(role === "fallback" ? (data.current?.fallback ?? null) : data.current?.[role], choices));

  const useRecommended = () => {
    const r = data.recommended;
    if (!r) return;
    setPicked({ builder: idOf(r.builder, choices), reviewer: idOf(r.reviewer, choices), fallback: idOf(r.fallback ?? null, choices) });
  };

  return (
    <SettingsSection title="模型">
      <SettingsCard>
        {choices.length === 0 ? (
          <SettingsRow label="可用的 agent" hint="Paseo 中还没有登录任何能无人值守运行的 agent。在 Paseo 中登录 Claude Code、Codex 等之后再打开这一页。" />
        ) : null}
        {ROLES.map(({ role, label, hint }) => (
          <SettingsSelect
            key={role}
            label={label}
            hint={hint}
            value={picked[role]}
            options={optionsFor(role)}
            disabled={readOnly || save.isPending}
            onValueChange={(v) => {
              setMessage(null);
              setPicked({ ...picked, [role]: v });
            }}
          />
        ))}
        {data.recommended ? (
          <SettingsAction label="按推荐选择" hint="不同厂商的模型分别做 builder 和 reviewer，再选一个做备用" actionLabel="填入推荐" disabled={readOnly || save.isPending} onPress={useRecommended} />
        ) : null}
        <SettingsAction
          label="保存到本机配置"
          hint={readOnly ? "插件设置为只读，不能在这里修改" : "写入 req-kit 的本机配置（原文件会备份）；之后开始的需求使用新的设置，进行中的不变"}
          actionLabel={save.isPending ? "保存中…" : "保存"}
          disabled={readOnly || save.isPending || !changed || !builder || !reviewer}
          onPress={() =>
            void save.mutateAsync({ builder: builder!, reviewer: reviewer!, fallback: profileOf("fallback", picked.fallback) }).then(
              (r) => setMessage(r.message),
              (e: Error) => setMessage(e.message),
            )
          }
        />
        {message ? <Text style={{ color: theme.colors.foregroundMuted }}>{message}</Text> : null}
      </SettingsCard>
    </SettingsSection>
  );
}
