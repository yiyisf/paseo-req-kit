// "req-kit 配置" (1.12): every setting that applies, in plain words, with where each one comes
// from (default, this machine, the team, the project) and how to change it. Read-only: changes
// go through the files, req configure, /req-setup, or the model settings page.
import type { PluginHostProps, PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ConfigItemData, ConfigLayer, ConfigViewData } from "../shared/contracts";
import { useConfigView, useRequirements } from "./data";
import { Badge, Chip, Status, useStyles } from "./ui";

type Theme = PluginHostProps["theme"];
type Layout = PluginHostProps["layout"];

const LAYER: Record<ConfigLayer, { label: string; tone: "accent" | "success" | "warning"; hint: string }> = {
  machine: { label: "本机", tone: "accent", hint: "这台机器自己的设置" },
  team: { label: "团队", tone: "warning", hint: "团队共用的配置，覆盖本机的同名设置" },
  project: { label: "项目", tone: "success", hint: "项目仓库中的设置，覆盖本机和团队的" },
};

const SCOPE_NOTE: Record<ConfigItemData["scope"], string | null> = {
  any: null,
  machine: "只能在本机配置中设置",
  machine_team: "只能在本机或团队配置中设置（会运行命令或发消息）",
};

/** Where an item's value comes from: the last file that set it to something other than the default. */
function originOf(item: ConfigItemData): ConfigLayer | null {
  return item.changed ? (item.setBy.at(-1) ?? null) : null;
}

function ItemRow({ theme, layout, item }: { theme: Theme; layout: Layout; item: ConfigItemData }) {
  const s = useStyles(theme, layout.compact);
  const [open, setOpen] = useState(false);
  const origin = originOf(item);
  const scope = SCOPE_NOTE[item.scope];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.label}：${item.display}`}
      accessibilityState={{ selected: open }}
      onPress={() => setOpen((v) => !v)}
      style={{ paddingVertical: 10, gap: 4 }}
    >
      <View style={[s.row, { justifyContent: "space-between", flexWrap: "nowrap" }]}>
        <Text style={[s.text, { fontWeight: "600", flexShrink: 1 }]}>{item.label}</Text>
        {origin ? (
          <Badge theme={theme} tone={LAYER[origin].tone}>
            {LAYER[origin].label}
          </Badge>
        ) : (
          <Badge theme={theme} tone="muted">
            默认
          </Badge>
        )}
      </View>
      <Text style={s.text}>{item.display}</Text>
      {item.description ? <Text style={s.muted}>{item.description}</Text> : null}
      {open ? (
        <View style={{ gap: 6, marginTop: 4 }}>
          <Text style={s.muted}>
            配置项 <Text style={{ fontFamily: "monospace", color: theme.colors.foreground }}>{item.key}</Text>
            {item.setBy.length > 0 ? ` · 写在${item.setBy.map((l) => LAYER[l].label).join("、")}配置中` : " · 没有在任何配置文件中写，用的是默认值"}
            {scope ? ` · ${scope}` : ""}
          </Text>
          <View style={{ backgroundColor: theme.colors.surface0, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, padding: 10 }}>
            <Text selectable style={{ fontFamily: "monospace", fontSize: 12, color: theme.colors.foreground }}>
              {JSON.stringify(item.value, null, 2) ?? "null"}
            </Text>
          </View>
        </View>
      ) : null}
    </Pressable>
  );
}

function Sources({ theme, layout, view }: { theme: Theme; layout: Layout; view: ConfigViewData }) {
  const s = useStyles(theme, layout.compact);
  return (
    <View style={[s.card, { gap: 8 }]}>
      <Text style={s.heading}>配置从哪里来</Text>
      <Text style={s.muted}>按下面的顺序叠加，后面的覆盖前面的；没有写的用 req-kit 的默认值。</Text>
      {view.sources.length === 0 ? <Text style={s.text}>还没有本机配置文件。在终端运行 req setup 生成。</Text> : null}
      {view.sources.map((src, i) => (
        <View key={src.path} style={[s.row, { flexWrap: "nowrap", alignItems: "flex-start" }]}>
          <Text style={[s.muted, { width: 18 }]}>{i + 1}.</Text>
          <Badge theme={theme} tone={LAYER[src.layer].tone}>
            {LAYER[src.layer].label}
          </Badge>
          <View style={{ flexShrink: 1, gap: 2 }}>
            <Text selectable style={[s.text, { fontFamily: "monospace", fontSize: 12 }]}>
              {src.path}
            </Text>
            <Text style={s.muted}>{LAYER[src.layer].hint}</Text>
          </View>
        </View>
      ))}
      {view.ignored.length > 0 ? <Text style={{ color: theme.colors.statusWarning, fontSize: 13 }}>没有生效：{view.ignored.join("、")}（这些设置不能写在团队或项目配置中）</Text> : null}
    </View>
  );
}

export function ConfigScreen({ theme, layout }: PluginScreenProps) {
  const s = useStyles(theme, layout.compact);
  const requirements = useRequirements();
  // A project is any checkout requirements were started from.
  const projects = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of requirements.data ?? []) if (r.present) map.set(r.sourceRepo ?? r.repo, r.project);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [requirements.data]);
  const [repo, setRepo] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [changedOnly, setChangedOnly] = useState(false);
  const config = useConfigView(repo);
  const view = config.data;

  const groups = useMemo(() => {
    if (!view) return [];
    const q = query.trim().toLowerCase();
    return view.groups
      .map((g) => ({
        ...g,
        items: g.items.filter(
          (i) => (!changedOnly || i.changed) && (!q || `${i.label} ${i.key} ${i.display} ${i.description}`.toLowerCase().includes(q)),
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [view, query, changedOnly]);
  const changedCount = view ? view.groups.reduce((n, g) => n + g.items.filter((i) => i.changed).length, 0) : 0;

  return (
    <View style={s.screen}>
      <ScrollView contentContainerStyle={s.body}>
        <View style={{ gap: 4 }}>
          <Text style={s.title}>req-kit 配置</Text>
          <Text style={s.muted}>这台机器上生效的全部设置，用大白话写出每一项是什么、现在是什么、来自哪个文件。这一页只看不改，修改方法在最下面。</Text>
        </View>

        <View style={{ gap: 6 }}>
          <Text style={s.heading}>看哪里的配置</Text>
          <View style={s.row}>
            <Chip theme={theme} label="本机（不含项目）" active={repo === null} onPress={() => setRepo(null)} />
            {projects.map(([dir, name]) => (
              <Chip key={dir} theme={theme} label={name} active={repo === dir} onPress={() => setRepo(dir)} />
            ))}
          </View>
          {projects.length === 0 ? <Text style={s.muted}>开始过需求的项目会出现在这里，可以看到项目配置叠加后的结果。</Text> : null}
        </View>

        <Status theme={theme} loading={config.isPending} error={config.error} />
        {view ? (
          <>
            {view.error ? (
              <View style={[s.card, { borderColor: theme.colors.statusDanger }]}>
                <Text style={[s.text, { color: theme.colors.statusDanger, fontWeight: "600" }]}>配置有错误，流水线现在无法启动</Text>
                <Text style={s.text}>{view.error}</Text>
                <Text style={s.muted}>下面显示的是各文件中写的值。修好后在终端运行 req doctor 检查。</Text>
              </View>
            ) : null}
            <Sources theme={theme} layout={layout} view={view} />

            <View style={{ gap: 8 }}>
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="搜索设置，例如：超时、备用模型、推送"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface1,
                  color: theme.colors.foreground,
                  fontSize: 14,
                }}
              />
              <View style={s.row}>
                <Chip theme={theme} label="全部" active={!changedOnly} onPress={() => setChangedOnly(false)} />
                <Chip theme={theme} label={`只看改过的（${changedCount}）`} active={changedOnly} onPress={() => setChangedOnly(true)} />
              </View>
            </View>

            {groups.length === 0 ? <Text style={s.muted}>{changedOnly && !query ? "所有设置都是默认值。" : "没有符合的设置。"}</Text> : null}
            {groups.map((g) => (
              <View key={g.id} style={{ gap: 6 }}>
                <View style={{ gap: 2 }}>
                  <Text style={[s.text, { fontSize: 15, fontWeight: "600" }]}>{g.title}</Text>
                  <Text style={s.muted}>{g.description}</Text>
                </View>
                <View style={[s.card, { paddingVertical: 2 }]}>
                  {g.items.map((item, i) => (
                    <View key={item.key}>
                      {i > 0 ? <View style={s.divider} /> : null}
                      <ItemRow theme={theme} layout={layout} item={item} />
                    </View>
                  ))}
                </View>
              </View>
            ))}

            <View style={[s.card, { gap: 6 }]}>
              <Text style={s.heading}>怎么修改</Text>
              <Text style={s.text}>· 模型（builder、reviewer、备用模型）：设置 → 插件 → req-kit → 模型，或在终端运行 req configure。</Text>
              <Text style={s.text}>· 项目的检查命令、服务启动方式、接哪些卡片：在项目的对话中运行 /req-setup。</Text>
              <Text style={s.text}>· 其他设置：编辑上面"配置从哪里来"中的文件，写法见 req-kit 文档的《项目定制与运行规则》。改完运行 req doctor 检查。</Text>
              <Text style={s.muted}>密码、令牌等看起来像密钥的值和个人账号不会在这里显示。</Text>
            </View>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
