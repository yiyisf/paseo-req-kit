// "等你处理" (1.12): everything that is waiting for a person, at the top, each with what to do and
// how long it has waited. Answers and plan confirmations can be given right here: an answer is
// passed to the requirement's chat (req reply), the same as typing it there.
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import type { Attention, Requirement } from "../shared/contracts";
import { useAction, usePreferences } from "./data";
import { facts } from "./format";
import { ReviewButton } from "./review";
import { Badge, Button, useStyles } from "./ui";

type Theme = PluginHostProps["theme"];
type Layout = PluginHostProps["layout"];

const KIND: Record<Exclude<Attention, null>, { label: string; tone: "warning" | "danger" | "muted"; todo: string }> = {
  approval: { label: "确认方案", tone: "warning", todo: "方案已通过审核。看一下“做完后会看到什么”，没问题就确认，开始写代码；要改就写下来。" },
  business: { label: "回答问题", tone: "warning", todo: "方案审核有问题只有你能决定，回答后开发会接着进行。" },
  permission: { label: "批准权限", tone: "warning", todo: "有一个步骤在等你允许它做一项操作，批准前会一直停在这里。打开这个 agent，在它的对话里选择允许或拒绝；拿不准时请开发同事看一下。" },
  interrupted: { label: "已中断", tone: "danger", todo: "开发中断了，自动处理没能解决。看一下原因，能继续就继续。" },
  not_completed: { label: "没有完成", tone: "muted", todo: "流水线结束了，但有部分没有做完。完成报告里写了原因和建议。" },
};

/** Plain waiting time: "等了 3 小时". */
export function waited(since: string, now = Date.now()): string {
  const m = (now - Date.parse(since)) / 60_000;
  if (!Number.isFinite(m) || m < 1) return "刚刚";
  if (m < 60) return `等了 ${Math.round(m)} 分钟`;
  if (m < 48 * 60) return `等了 ${Math.round(m / 60)} 小时`;
  return `等了 ${Math.round(m / 60 / 24)} 天`;
}

/** Longest-waiting first: the oldest decision is the one holding things up most. */
export function inboxItems(items: Requirement[]): Requirement[] {
  return items
    .filter((r) => r.attention)
    .sort((a, b) => (a.waiting?.since ?? a.updatedAt).localeCompare(b.waiting?.since ?? b.updatedAt));
}

function InboxCard({ theme, layout, item, open, readOnly, openAgent }: { theme: Theme; layout: Layout; item: Requirement; open(): void; readOnly: boolean; openAgent?: (agentId: string) => void }) {
  const s = useStyles(theme, layout.compact);
  const run = useAction();
  const toast = useToast();
  const [writing, setWriting] = useState(item.attention === "business");
  const [text, setText] = useState("");
  const kind = KIND[item.attention!];
  const w = item.waiting;
  const repo = item.sourceRepo ?? item.repo;

  const act = async (action: "approve" | "resume" | "reply") => {
    try {
      const result = await run.mutateAsync({ action, repo, featureDir: item.featureDir, ...(action === "reply" ? { text } : {}) });
      const first = result.message.split("\n").find((l) => l.trim()) ?? "";
      if (result.ok) {
        toast.show(first || "已完成", { variant: "success", durationMs: 4000 });
        setText("");
      } else toast.error(first || "没有完成");
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  return (
    <View style={[s.card, { gap: 10, borderLeftWidth: 3, borderLeftColor: kind.tone === "danger" ? theme.colors.statusDanger : kind.tone === "warning" ? theme.colors.statusWarning : theme.colors.border }]}>
      <View style={[s.row, { justifyContent: "space-between" }]}>
        <View style={[s.row, { flexShrink: 1 }]}>
          <Badge theme={theme} tone={kind.tone}>
            {kind.label}
          </Badge>
          <Text style={[s.text, { fontWeight: "600", flexShrink: 1 }]}>{item.title}</Text>
        </View>
        <Text style={s.muted}>{waited(w?.since ?? item.updatedAt)}</Text>
      </View>
      <Text style={s.muted}>
        {facts(item)}
        {w?.card ? ` · 卡片 ${w.card.system} ${w.card.id}${w.card.requester ? `（${w.card.requester}）` : ""}` : ""}
      </Text>
      <Text style={s.text}>{kind.todo}</Text>

      {(item.attention === "business" || item.attention === "permission") && w && w.questions.length > 0 ? (
        <View style={{ gap: 4 }}>
          {item.attention === "permission" ? <Text style={s.muted}>{w.reason}。要批准的操作：</Text> : null}
          {w.questions.map((q, i) => (
            <Text key={i} style={s.text}>
              {i + 1}. {q}
            </Text>
          ))}
        </View>
      ) : null}
      {item.attention === "interrupted" && w?.reason ? (
        <Text style={s.danger} numberOfLines={4}>
          {w.reason}
        </Text>
      ) : null}

      {readOnly ? (
        <View style={s.row}>
          <Button theme={theme} label="查看详情" onPress={open} />
          <Text style={s.muted}>插件设置为只读，请在对话中处理</Text>
        </View>
      ) : (
        <>
          {item.attention === "approval" && item.hasPrototype ? <Text style={s.text}>这个方案有界面原型：在原型上点选要改的地方，比写文字说得清楚。</Text> : null}
          {writing && w?.canReply ? (
            <View style={{ gap: 8 }}>
              <TextInput
                value={text}
                onChangeText={setText}
                multiline
                placeholder={item.attention === "approval" ? "写下要改的地方，例如：按钮放在右上角" : w.questions.length > 1 ? "按编号回答，例如：1. 只有新订单显示  2. 不需要" : "写下你的回答"}
                placeholderTextColor={theme.colors.foregroundMuted}
                style={{
                  minHeight: 72,
                  padding: 10,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface0,
                  color: theme.colors.foreground,
                  fontSize: 14,
                  textAlignVertical: "top",
                }}
              />
              {w.card ? <Text style={s.muted}>也可以在卡片的“需求方回复”区回答，效果一样。</Text> : null}
            </View>
          ) : null}
          <View style={s.row}>
            {item.attention === "approval" ? (
              <>
                {item.hasPrototype ? <ReviewButton theme={theme} repo={repo} featureDir={item.featureDir} title={item.title} waiting /> : null}
                <Button theme={theme} primary={!item.hasPrototype} label={run.isPending ? "正在执行…" : "确认方案"} disabled={run.isPending} onPress={() => void act("approve")} />
                {w?.canReply ? (
                  writing ? (
                    <Button theme={theme} label="发送修改意见" disabled={run.isPending || !text.trim()} onPress={() => void act("reply")} />
                  ) : (
                    <Button theme={theme} label="提修改意见" onPress={() => setWriting(true)} />
                  )
                ) : null}
              </>
            ) : null}
            {item.attention === "business" && w?.canReply ? (
              <Button theme={theme} primary label={run.isPending ? "正在发送…" : "发送回答"} disabled={run.isPending || !text.trim()} onPress={() => void act("reply")} />
            ) : null}
            {item.attention === "permission" && w?.agentId && openAgent ? <Button theme={theme} primary label="打开这个 agent" onPress={() => openAgent(w.agentId!)} /> : null}
            {item.attention === "interrupted" ? (
              <Button theme={theme} primary label={run.isPending ? "正在执行…" : "继续"} disabled={run.isPending} onPress={() => void act("resume")} />
            ) : null}
            <Button theme={theme} label={item.attention === "approval" ? "看方案和确认预览" : item.attention === "not_completed" ? "看完成报告" : "查看详情"} onPress={open} />
          </View>
        </>
      )}
    </View>
  );
}

export function Inbox({ theme, layout, items, open, openAgent }: { theme: Theme; layout: Layout; items: Requirement[]; open(item: Requirement): void; openAgent?: (agentId: string) => void }) {
  const s = useStyles(theme, layout.compact);
  const { readOnly } = usePreferences();
  const waiting = inboxItems(items);
  return (
    <View style={{ gap: 10 }}>
      <View style={[s.row, { justifyContent: "space-between" }]}>
        <Text style={[s.title, { fontSize: 16 }]}>等你处理{waiting.length > 0 ? `（${waiting.length}）` : ""}</Text>
        {waiting.length > 0 ? <Text style={s.muted}>等得最久的在前</Text> : null}
      </View>
      {waiting.length === 0 ? (
        <View style={[s.card, { flexDirection: "row", alignItems: "center", gap: 8 }]}>
          <Badge theme={theme} tone="success">
            没有
          </Badge>
          <Text style={s.muted}>现在没有需要你处理的事。需要你确认或回答时，会出现在这里。</Text>
        </View>
      ) : (
        waiting.map((item) => <InboxCard key={item.key} theme={theme} layout={layout} item={item} open={() => open(item)} readOnly={readOnly} openAgent={openAgent} />)
      )}
    </View>
  );
}
