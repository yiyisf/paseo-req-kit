// "审查原型" (1.13): the prototype review page inside Paseo. On the web and desktop apps it is
// embedded in this screen; on phones (and as a fallback) it opens in the browser.
import type { PluginHostProps, PluginScreenProps } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { useReviewUrl } from "./data";
import { openReview } from "./nav";
import { Button, Status, useStyles } from "./ui";
import { canEmbedPages, embeddedPage } from "./web";

type Theme = PluginHostProps["theme"];

/** The button on a requirement with a prototype: primary while the design waits for confirmation. */
export function ReviewButton({ theme, repo, featureDir, title, waiting }: { theme: Theme; repo: string; featureDir: string; title: string; waiting: boolean }) {
  return <Button theme={theme} primary={waiting} label={waiting ? "审查原型并确认方案" : "审查原型"} onPress={() => openReview({ repo, featureDir, title })} />;
}

export function ReviewScreen({ theme, layout, params }: PluginScreenProps) {
  const s = useStyles(theme, layout.compact);
  const repo = params.repo ?? "";
  const featureDir = params.featureDir ?? "";
  const review = useReviewUrl(repo, featureDir, true);
  if (!review.data) {
    return (
      <View style={[s.screen, { padding: 16 }]}>
        <Status theme={theme} loading={review.isPending} error={review.error} />
      </View>
    );
  }
  const { url, readOnly } = review.data;
  const frame = canEmbedPages ? embeddedPage(url, `原型审查：${params.title ?? featureDir}`) : null;
  return (
    <View style={[s.screen, { gap: 6 }]}>
      <View style={[s.row, { paddingHorizontal: 12, paddingTop: 8, justifyContent: "space-between" }]}>
        <Text style={s.muted}>{readOnly ? "插件设为只读：可以看原型，不能提交意见或确认。" : "点原型上要改的地方提意见，双击文字直接改字；看完在右下角提交或确认方案。"}</Text>
        <ExternalLink href={url}>在新窗口打开</ExternalLink>
      </View>
      {frame ?? (
        <View style={[s.card, { margin: 12, gap: 8 }]}>
          <Text style={s.text}>原型审查页在浏览器中打开效果最好（手机上屏幕较小，建议用电脑）。</Text>
          <ExternalLink href={url}>打开原型审查页</ExternalLink>
        </View>
      )}
    </View>
  );
}
