// "审查原型" (1.13): the prototype review page inside Paseo. On the web and desktop apps it is
// embedded in this screen; on phones (and as a fallback) it opens in the browser.
import type { PluginHostProps, PluginScreenProps } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { useReviewUrl } from "./data";
import { openChecklist, openReview } from "./nav";
import { Button, Status, useStyles } from "./ui";
import { canEmbedPages, embeddedPage, reviewUnreachable } from "./web";

type Theme = PluginHostProps["theme"];

/** 1.14: the acceptance checklist, primary while the requirement waits for acceptance. */
export function ChecklistButton({ theme, repo, featureDir, title, primary }: { theme: Theme; repo: string; featureDir: string; title: string; primary: boolean }) {
  return <Button theme={theme} primary={primary} label="验收清单（可一键试用）" onPress={() => openChecklist({ repo, featureDir, title })} />;
}

/** The button on a requirement with a prototype: primary while the design waits for confirmation. */
export function ReviewButton({ theme, repo, featureDir, title, waiting }: { theme: Theme; repo: string; featureDir: string; title: string; waiting: boolean }) {
  return <Button theme={theme} primary={waiting} label={waiting ? "审查原型并确认方案" : "审查原型"} onPress={() => openReview({ repo, featureDir, title })} />;
}

export function ReviewScreen({ theme, layout, params }: PluginScreenProps) {
  const s = useStyles(theme, layout.compact);
  const repo = params.repo ?? "";
  const featureDir = params.featureDir ?? "";
  const page = params.page === "check" ? "check" : "prototype";
  const review = useReviewUrl(repo, featureDir, true, page);
  if (!review.data) {
    return (
      <View style={[s.screen, { padding: 16 }]}>
        <Status theme={theme} loading={review.isPending} error={review.error} />
      </View>
    );
  }
  const { url, readOnly } = review.data;
  if (reviewUnreachable(url)) {
    return (
      <View style={[s.screen, { padding: 12 }]}>
        <View style={[s.card, { gap: 8 }]}>
          <Text style={s.text}>原型审查页只在运行 Paseo 的那台电脑上能打开（地址是 {new URL(url).host}），你现在是从另一台电脑打开的 Paseo 网页，所以看不到。</Text>
          <Text style={s.muted}>{`办法：到运行 Paseo 的那台电脑上打开 Paseo 网页再点"审查原型"；或者请管理员在那台电脑上设置环境变量 REQ_KIT_REVIEW_HOST=0.0.0.0 和 REQ_KIT_REVIEW_PUBLIC_URL=http://<那台电脑的地址>:6781，再重启 Paseo daemon，审查页就能从别的电脑打开（能连上那台电脑的人都能看到审查页，提交意见要用页面地址里的口令）。也可以直接看功能目录里的 preview.md 和 prototype/。`}</Text>
        </View>
      </View>
    );
  }
  const frame = canEmbedPages ? embeddedPage(url, `${page === "check" ? "验收清单" : "原型审查"}：${params.title ?? featureDir}`) : null;
  return (
    <View style={[s.screen, { gap: 6 }]}>
      <View style={[s.row, { paddingHorizontal: 12, paddingTop: 8, justifyContent: "space-between" }]}>
        <Text style={s.muted}>
          {page === "check"
            ? readOnly
              ? "插件设为只读：可以看清单，不能提交。"
              : "逐条核对：通过、不对（写下看到了什么）、先不验；需要时点右上角把它跑起来。"
            : readOnly
              ? "插件设为只读：可以看原型，不能提交意见或确认。"
              : "点原型上要改的地方提意见，双击文字直接改字；看完在右下角提交或确认方案。"}
        </Text>
        <ExternalLink href={url}>在新窗口打开</ExternalLink>
      </View>
      {frame ?? (
        <View style={[s.card, { margin: 12, gap: 8 }]}>
          <Text style={s.text}>{page === "check" ? "验收清单" : "原型审查页"}在浏览器中打开效果最好（手机上屏幕较小，建议用电脑）。</Text>
          <ExternalLink href={url}>{page === "check" ? "打开验收清单" : "打开原型审查页"}</ExternalLink>
        </View>
      )}
    </View>
  );
}
