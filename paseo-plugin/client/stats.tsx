// Usage statistics (req stats): for whoever reports on how requirements went.
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import { useStats } from "./data";
import { minutes, tokens, TYPE_LABELS } from "./format";
import { BrandHeader, Chip, Eyebrow, rk, Status, useStyles } from "./ui";

type Tokens = NonNullable<import("../shared/contracts").StatsSummary["tokens"]>;

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Where the tokens went (1.13): a bar per step and per model, and the share spent on rework. */
function TokenShare({ theme, compact, t }: { theme: import("@getpaseo/plugin/client").PluginHostProps["theme"]; compact: boolean; t: Tokens }) {
  const s = useStyles(theme, compact);
  const bar = (key: string, label: string, value: number, share: number, note: string) => (
    <View key={key} style={{ gap: 2 }}>
      <View style={[s.row, { justifyContent: "space-between", flexWrap: "nowrap" }]}>
        <Text style={[s.text, { flexShrink: 1 }]}>{label}</Text>
        <Text style={s.muted}>
          {tokens(value)} · {pct(share)}
          {note}
        </Text>
      </View>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
        <View style={{ width: `${Math.max(1, Math.round(share * 100))}%`, height: 6, backgroundColor: rk(theme).data }} />
      </View>
    </View>
  );
  return (
    <View style={[s.card, { gap: 10 }]}>
      <Eyebrow theme={theme} right={<Text style={s.muted}>token 花在哪</Text>}>TOKENS</Eyebrow>
      <Text style={s.text}>
        合计 {tokens(t.total)} tokens
        {t.rework ? `，其中返工（修订、修复、复验和第 2 轮起的评审）占 ${pct(t.rework.share)}` : ""}
        {t.cachedShare !== null ? `；输入中 ${pct(t.cachedShare)} 来自提示缓存` : ""}
      </Text>
      {t.perRequirement.median !== null ? <Text style={s.muted}>每个完成的需求中位数 {tokens(t.perRequirement.median)}</Text> : null}
      <View style={{ gap: 8 }}>{t.byStep.slice(0, 12).map((r) => bar(r.stepId, r.title, r.tokens, r.share, `（${r.steps} 次）`))}</View>
      {t.byAgent.some((a) => a.agent !== "（未记录）") ? (
        <>
          <Text style={[s.text, { fontWeight: "600" }]}>按模型</Text>
          <View style={{ gap: 8 }}>{t.byAgent.map((r) => bar(r.agent, r.agent, r.tokens, r.share, `（${r.steps} 步）`))}</View>
        </>
      ) : null}
    </View>
  );
}

function month(offset: number, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const OUTCOME: Record<string, string> = { completed: "已完成", completed_with_issues: "有遗留问题", not_completed: "未完成", unknown: "结论未记录" };

export function StatsScreen({ theme, layout }: PluginScreenProps) {
  const s = useStyles(theme, layout.compact);
  const periods = [
    { label: "最近 30 天", value: { since: "30d" } },
    { label: "本月", value: { month: month(0) } },
    { label: "上月", value: { month: month(-1) } },
  ];
  const [pick, setPick] = useState(0);
  const query = useStats(periods[pick].value);
  const d = query.data;
  const card = (label: string, value: string, note?: string) => (
    <View key={label} style={[s.card, { minWidth: layout.compact ? "45%" : 160, flexGrow: 1 }]}>
      <Text style={s.muted}>{label}</Text>
      <Text style={[s.text, { fontSize: 22, fontWeight: "600" }]}>{value}</Text>
      {note ? <Text style={s.muted}>{note}</Text> : null}
    </View>
  );
  return (
    <View style={s.screen}>
      <ScrollView contentContainerStyle={s.body}>
        <BrandHeader theme={theme} page="使用统计" />
        <View style={s.row}>
          {periods.map((p, i) => (
            <Chip key={p.label} theme={theme} label={p.label} active={i === pick} onPress={() => setPick(i)} />
          ))}
        </View>
        <Status theme={theme} loading={query.isPending} error={query.error} empty={d && d.active === 0 ? "这段时间没有流水线运行记录。" : null} />
        {d && d.active > 0 ? (
          <>
            <View style={[s.row, { alignItems: "stretch" }]}>
              {card("有进展的需求", String(d.active), Object.entries(d.byType).map(([k, v]) => `${TYPE_LABELS[k] ?? "普通"} ${v}`).join("，"))}
              {card("完成", String(d.completed.total), Object.entries(d.completed.byOutcome).map(([k, v]) => `${OUTCOME[k] ?? k} ${v}`).join("，"))}
              {card("交付周期中位数", d.cycleHours.median === null ? "-" : `${d.cycleHours.median} 小时`, "首次开始到完成")}
              {card("平均评审轮数", d.rework.averageReviewRounds === null ? "-" : String(d.rework.averageReviewRounds), d.rework.withDefectRounds === null ? undefined : `${Math.round(d.rework.withDefectRounds * 100)}% 需要缺陷修复`)}
              {card("agent 合计用时", minutes(d.usage.agentMinutes), `输入 ${tokens(d.usage.inputTokens)}，输出 ${tokens(d.usage.outputTokens)} tokens`)}
              {d.usage.costUsd !== null ? card("费用", `$${d.usage.costUsd.toFixed(2)}`) : null}
            </View>
            {d.oversight && d.oversight.reviews.total + d.oversight.acceptance.total + d.oversight.merged.requirements + d.oversight.issues.total > 0 ? (
              <View style={s.card}>
                <Eyebrow theme={theme} right={<Text style={s.muted}>人工把关和合并后</Text>}>OVERSIGHT</Eyebrow>
                <Text style={s.text}>
                  人工代码评审 {d.oversight.reviews.total} 次（{d.oversight.reviews.requirements} 个需求），退回修改 {d.oversight.reviews.sentBack} 次；第一次就通过 {d.oversight.reviews.passedFirstTime} 个
                </Text>
                <Text style={s.text}>
                  需求方验收 {d.oversight.acceptance.total} 次，不通过 {d.oversight.acceptance.failed} 次；第一次就通过 {d.oversight.acceptance.passedFirstTime} 个
                </Text>
                <Text style={s.text}>
                  合并进主干 {d.oversight.merged.requirements} 个需求
                  {d.oversight.merged.medianHoursAfterCompletion === null ? "" : `，完成到合并中位数 ${d.oversight.merged.medianHoursAfterCompletion} 小时`}；合并后发现问题 {d.oversight.issues.total} 个
                </Text>
              </View>
            ) : null}
            {d.tokens?.total ? <TokenShare theme={theme} compact={layout.compact} t={d.tokens} /> : null}
            {d.waits.length > 0 ? (
              <View style={s.card}>
                <Text style={s.heading}>等待</Text>
                {d.waits.map((w) => (
                  <Text key={w.kind} style={s.text}>
                    {w.label}：{w.requirements} 个需求，平均 {minutes(w.averageMinutes)}
                  </Text>
                ))}
              </View>
            ) : null}
            <View style={s.card}>
              <Text style={s.heading}>各步骤用时</Text>
              {d.steps.map((st) => (
                <Text key={st.stepId} style={s.text}>
                  {st.title}：{st.count} 次，平均 {minutes(st.averageMinutes)}，合计 {minutes(st.totalMinutes)}
                </Text>
              ))}
              <Text style={s.muted}>
                质量门运行 {d.rework.gateRuns} 次，发现新失败 {d.rework.gateFailed} 次。机器：{d.machines.join("、")}
              </Text>
            </View>
            <Text style={s.muted}>给管理方的汇报文件：在终端运行 req stats --report --month {month(0)}；几台机器一起汇报见 req stats --export 和 --merge。</Text>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
