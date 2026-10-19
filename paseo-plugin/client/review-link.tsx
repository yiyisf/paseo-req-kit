// "审查原型" (1.13): opens the prototype review page in a new browser tab. The address is fetched
// ahead of the click, so the browser lets the link open a tab.
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { useReviewUrl } from "./data";
import { useStyles } from "./ui";

export function ReviewLink({ theme, compact, repo, featureDir, waiting }: { theme: PluginHostProps["theme"]; compact: boolean; repo: string; featureDir: string; waiting: boolean }) {
  const s = useStyles(theme, compact);
  const review = useReviewUrl(repo, featureDir, true);
  return (
    <View style={[s.card, { gap: 4, borderColor: waiting ? theme.colors.accent : theme.colors.border }]}>
      <Text style={s.heading}>界面原型</Text>
      <Text style={s.muted}>
        {waiting
          ? "在原型上直接点要改的地方、双击改文字，不用描述专业词汇；看完在那里提交意见或确认方案。"
          : "可以先在原型上标出要改的地方，意见会自动保存，等到要确认方案时再提交。"}
      </Text>
      {review.data ? (
        <ExternalLink href={review.data.url}>{review.data.readOnly ? "查看原型（只读）" : "打开原型审查页"}</ExternalLink>
      ) : review.error ? (
        <Text style={s.danger}>打不开原型审查页：{(review.error as Error).message}</Text>
      ) : (
        <Text style={s.muted}>正在准备原型审查页…</Text>
      )}
    </View>
  );
}
