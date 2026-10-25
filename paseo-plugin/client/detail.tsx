// One requirement: where it stands, its steps, the quality gate, its documents, and the
// management actions (each one is `req <command>` on the daemon machine, after confirming).
import type { PluginHostProps, PluginScreenProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Action, RequirementDetail, Step } from "../shared/contracts";
import { useAction, useDocument, usePreferences, useRequirement, useRequirements } from "./data";
import { ACTION_TEXT, actionsFor, ago, ATTENTION_LABELS, facts, FILE_LABELS, minutes, tokens, trackOf } from "./format";
import { Markdown, tsvToMarkdown } from "./markdown";
import { ChecklistButton, CodeReviewButton, ReviewButton } from "./review";
import { Badge, Button, Chip, Eyebrow, rk, Status, StepTrack, useStyles } from "./ui";

type Theme = PluginHostProps["theme"];
type Layout = PluginHostProps["layout"];
type Navigation = PluginSurfaceProps["navigation"];

const OUTCOME_LABELS: Record<Step["outcome"], string> = { running: "运行中", completed: "完成", failed: "失败" };

function StepRow({ theme, layout, step, navigation }: { theme: Theme; layout: Layout; step: Step; navigation: Navigation }) {
  const s = useStyles(theme, layout.compact);
  const tone = step.outcome === "failed" ? "danger" : step.outcome === "running" ? "running" : "muted";
  const body = (
    <View style={{ gap: 2, paddingVertical: 6 }}>
      <View style={s.row}>
        <Text style={[s.text, { flexShrink: 1 }]}>{step.title}</Text>
        <Badge theme={theme} tone={tone}>
          {step.outcome === "completed" && step.result ? step.result : OUTCOME_LABELS[step.outcome]}
        </Badge>
      </View>
      <Text style={s.muted}>
        第 {step.attempt} 次尝试 · {minutes(step.minutes)} · {ago(step.startedAt)}开始
      </Text>
      {step.error ? <Text style={s.danger}>{step.error}</Text> : null}
    </View>
  );
  // A step agent opens in Paseo, where its whole conversation is.
  if (!navigation || !step.agentId) return body;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`打开 ${step.title} 的 agent`} onPress={() => navigation.openAgent({ agentId: step.agentId })}>
      {body}
    </Pressable>
  );
}

function DocumentModal({
  theme,
  layout,
  repo,
  featureDir,
  file,
  onClose,
}: {
  theme: Theme;
  layout: Layout;
  repo: string;
  featureDir: string;
  file: string | null;
  onClose(): void;
}) {
  const s = useStyles(theme, layout.compact);
  const doc = useDocument(repo, featureDir, file);
  return (
    <Modal title={file ? `${FILE_LABELS[file] ?? file}（${file}）` : ""} open={file !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <Status theme={theme} loading={doc.isPending} error={doc.error} />
        {doc.data ? (
          <>
            <Markdown theme={theme} source={doc.data.file.endsWith(".tsv") ? tsvToMarkdown(doc.data.content) : doc.data.content} />
            {doc.data.truncated ? <Text style={s.muted}>文件较大，只显示了开头的 512 KB。</Text> : null}
          </>
        ) : null}
      </Modal.Content>
    </Modal>
  );
}

function ActionModal({
  theme,
  layout,
  detail,
  action,
  onClose,
}: {
  theme: Theme;
  layout: Layout;
  detail: RequirementDetail;
  action: Action | null;
  onClose(): void;
}) {
  const s = useStyles(theme, layout.compact);
  const run = useAction();
  const toast = useToast();
  const go = async (verifyEnv?: "local" | "deployed") => {
    if (!action) return;
    try {
      const result = await run.mutateAsync({ action, repo: detail.sourceRepo ?? detail.repo, featureDir: detail.featureDir, verifyEnv });
      const first = result.message.split("\n").find((l) => l.trim()) ?? "";
      if (result.ok) toast.show(first || "已完成", { variant: "success", durationMs: 4000 });
      else toast.error(first || "没有完成");
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };
  const text = action ? ACTION_TEXT[action] : null;
  return (
    <Modal title={text ? `${text.label}：${detail.title}` : ""} open={action !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <Text style={s.text}>{text?.confirm}</Text>
        {action === "approve" && detail.files.includes("preview.md") ? <Text style={s.muted}>确认预览在本页的"文档"中：确认预览（preview.md）。</Text> : null}
        <View style={s.row}>
          {action === "verify" ? (
            <>
              <Button theme={theme} primary label="在本地验证" disabled={run.isPending} onPress={() => void go("local")} />
              <Button theme={theme} label="在已部署的测试环境验证" disabled={run.isPending} onPress={() => void go("deployed")} />
            </>
          ) : (
            <Button theme={theme} primary label={run.isPending ? "正在执行…" : (text?.label ?? "")} disabled={run.isPending} onPress={() => void go()} />
          )}
          <Button theme={theme} label="取消" disabled={run.isPending} onPress={onClose} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

function GateSummary({ theme, layout, detail }: { theme: Theme; layout: Layout; detail: RequirementDetail }) {
  const s = useStyles(theme, layout.compact);
  const runs = [...(detail.gate?.runs ?? []), ...detail.joint.flatMap((j) => j.gate?.runs ?? [])];
  if (runs.length === 0) return null;
  const last = runs.at(-1)!;
  const failed = runs.filter((r) => !r.passed).length;
  return (
    <View style={s.card}>
      <Text style={s.heading}>质量门</Text>
      <Text style={s.text}>
        运行 {runs.length} 次{failed > 0 ? `，其中 ${failed} 次发现改动带来的新失败` : "，都没有新失败"}
      </Text>
      <Text style={s.muted}>
        最近一次（{last.key}）：{last.passed ? "通过" : `新失败：${last.newFailures.join("、")}`}
      </Text>
    </View>
  );
}

export function RequirementView({
  theme,
  layout,
  navigation,
  repo,
  featureDir,
}: {
  theme: Theme;
  layout: Layout;
  navigation: Navigation;
  repo: string;
  featureDir: string;
}) {
  const s = useStyles(theme, layout.compact);
  const query = useRequirement(repo, featureDir);
  const { readOnly } = usePreferences();
  const [doc, setDoc] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [allSteps, setAllSteps] = useState(false);
  const d = query.data;
  if (!d) return <Status theme={theme} loading={query.isPending} error={query.error} />;
  const steps = allSteps ? d.steps : d.steps.slice(-12);
  const actions = readOnly ? [] : actionsFor(d);
  // 1.14: finished (it has a report) and not running: the requester can try it and accept it.
  const canAccept = d.files.includes("report.md") && !d.running;
  // 1.14: code written and reviewed by the AI: a person can review it too.
  const canReviewCode = (d.files.includes("code-review.md") || d.files.includes("implementation.md")) && !d.running;
  const hr = d.humanReview ?? null;
  const reviewLabel = !hr ? "代码审查" : hr.status === "approved" ? (hr.stale ? "代码审查（有新改动，需重新评审）" : "代码审查（已通过）") : "代码审查（已退回修改）";
  // 1.15: one lime button, the decision this requirement waits for now.
  const waitingAcceptance = d.stage.startsWith("待验收") || d.stage === "验收未通过";
  const codeNeedsReview = canReviewCode && (!hr || hr.stale) && (d.status === "completed" || d.status === "phase_done");
  const primary: "review" | "code" | "check" | Action | null =
    d.attention === "approval" && d.hasPrototype
      ? "review"
      : codeNeedsReview
        ? "code"
        : canAccept && waitingAcceptance
          ? "check"
          : (actions.find((a) => a !== "stop" && !(a === "approve" && d.hasPrototype)) ?? null);
  const c = rk(theme);
  return (
    <View style={{ gap: 16 }}>
      <View style={[s.card, { gap: 12 }]}>
        <Eyebrow theme={theme} accent right={<Text style={s.mono} numberOfLines={1}>{d.branch ?? d.name}</Text>}>
          REQUIREMENT
        </Eyebrow>
        <View style={s.row}>
          <Text style={s.title}>{d.title}</Text>
          {d.attention ? (
            <Badge theme={theme} tone={d.attention === "interrupted" ? "danger" : d.attention === "not_completed" ? "warning" : "needs"}>
              {ATTENTION_LABELS[d.attention]}
            </Badge>
          ) : d.running ? (
            <Badge theme={theme} tone="running" icon="LoaderCircle">
              进行中
            </Badge>
          ) : null}
        </View>
        <StepTrack theme={theme} steps={trackOf(d, hr)} />
        <Text style={s.muted}>{facts(d)}</Text>
        <Text style={[s.text, { color: d.attention ? c.brandText : theme.colors.foreground }]}>{d.stage}</Text>
        {d.estimate && d.attention !== "approval" ? (
          <Text style={s.muted}>
            {d.estimate.over
              ? `已超过同档位需求通常的用时（已用 ${minutes(d.estimate.usedAgentMinutes)}，通常 ${minutes(d.estimate.typicalAgentMinutes)}）`
              : `预计还要约 ${minutes(Math.max(5, d.estimate.leftMinutes))}`}
            {d.estimate.usedTokens !== null ? ` · 已用 ${tokens(d.estimate.usedTokens)} tokens${d.estimate.typicalTokens !== null ? `（通常 ${tokens(d.estimate.typicalTokens)}）` : ""}` : ""}
            {` · 按本机最近 ${d.estimate.basis} 个同档位需求，不含等人的时间`}
          </Text>
        ) : null}
        {d.run?.stopReason && !d.running ? <Text style={s.danger}>{d.run.stopReason}</Text> : null}
        {d.attention === "business" ? <Text style={s.muted}>需求方的决定请在发起需求的对话中回答，回答后再继续。</Text> : null}
      </View>

      {actions.length > 0 || d.hasPrototype || canAccept || canReviewCode ? (
        <View style={s.row}>
          {canReviewCode ? <CodeReviewButton theme={theme} repo={d.sourceRepo ?? d.repo} featureDir={d.featureDir} title={d.title} label={reviewLabel} primary={primary === "code"} /> : null}
          {canAccept ? <ChecklistButton theme={theme} repo={d.sourceRepo ?? d.repo} featureDir={d.featureDir} title={d.title} primary={primary === "check"} /> : null}
          {d.hasPrototype ? <ReviewButton theme={theme} repo={d.sourceRepo ?? d.repo} featureDir={d.featureDir} title={d.title} waiting={primary === "review"} /> : null}
          {actions.map((a) => (
            <Button key={a} theme={theme} primary={primary === a} label={ACTION_TEXT[a].label} onPress={() => setAction(a)} />
          ))}
        </View>
      ) : null}

      {d.files.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Text style={s.heading}>文档</Text>
          <View style={s.row}>
            {d.files.map((f) => (
              <Chip key={f} theme={theme} label={FILE_LABELS[f] ?? f} active={false} onPress={() => setDoc(f)} />
            ))}
          </View>
        </View>
      ) : null}

      <View style={s.card}>
        <Text style={s.heading}>位置</Text>
        <Text selectable style={s.text}>
          {d.repo}/{d.featureDir}
        </Text>
        {d.branch ? <Text style={s.muted}>分支 {d.branch}</Text> : null}
        {d.workspaceId && navigation ? (
          <Pressable accessibilityRole="button" onPress={() => navigation.openWorkspace({ workspaceId: d.workspaceId! })}>
            <Text style={{ color: rk(theme).brandText, fontSize: 13, fontWeight: "600" }}>打开这个需求的工作区</Text>
          </Pressable>
        ) : null}
        {d.joint.map((j) => (
          <Text key={j.name} style={s.muted}>
            联合开发「{j.name}」：{j.repo}（分支 {j.branch}）
          </Text>
        ))}
      </View>

      {(d.external ?? []).length > 0 ? (
        <View style={s.card}>
          <Text style={s.heading}>外部系统</Text>
          {(d.external ?? []).map((e) => (
            <View key={e.name} style={{ gap: 2 }}>
              <View style={s.row}>
                <Text style={s.text}>
                  {e.name}：{e.id ?? "还没有建卡"}
                </Text>
                {e.status ? (
                  <Badge theme={theme} tone="muted">
                    {e.status}
                  </Badge>
                ) : null}
              </View>
              {e.url ? <ExternalLink href={e.url}>打开卡片</ExternalLink> : null}
              {e.pending > 0 ? (
                <Text style={s.danger}>
                  有 {e.pending} 次调用没有成功：{e.lastError}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {d.usage ? (
        <View style={s.card}>
          <Text style={s.heading}>用时与用量</Text>
          <Text style={s.text}>
            {d.usage.steps} 个步骤，agent 合计 {minutes(d.usage.agentMinutes)}
          </Text>
          <Text style={s.muted}>
            输入 {tokens(d.usage.inputTokens)} tokens，输出 {tokens(d.usage.outputTokens)} tokens
            {d.usage.costUsd !== null ? `，约 $${d.usage.costUsd.toFixed(2)}` : ""}
          </Text>
        </View>
      ) : null}

      <GateSummary theme={theme} layout={layout} detail={d} />

      {d.steps.length > 0 ? (
        <View style={s.card}>
          <View style={s.row}>
            <Text style={s.heading}>步骤（{d.steps.length}）</Text>
            {d.steps.length > 12 ? <Button theme={theme} label={allSteps ? "只看最近的" : "显示全部"} onPress={() => setAllSteps((v) => !v)} /> : null}
          </View>
          {steps.map((step) => (
            <StepRow key={`${step.key}-${step.attempt}-${step.startedAt}`} theme={theme} layout={layout} step={step} navigation={navigation} />
          ))}
        </View>
      ) : null}

      <DocumentModal theme={theme} layout={layout} repo={d.repo} featureDir={d.featureDir} file={doc} onClose={() => setDoc(null)} />
      <ActionModal theme={theme} layout={layout} detail={d} action={action} onClose={() => setAction(null)} />
    </View>
  );
}

export function RequirementScreen({ theme, layout, navigation, params }: PluginScreenProps) {
  const s = useStyles(theme, layout.compact);
  // Opened from a step agent's pill: only the requirement's name is known; find it in the list.
  const list = useRequirements();
  const byName = !params.repo && params.name ? (list.data ?? []).find((r) => r.name === params.name) : null;
  const repo = params.repo ?? byName?.repo;
  const featureDir = params.featureDir ?? byName?.featureDir;
  return (
    <View style={s.screen}>
      <ScrollView contentContainerStyle={s.body}>
        {repo && featureDir ? (
          <RequirementView theme={theme} layout={layout} navigation={navigation} repo={repo} featureDir={featureDir} />
        ) : params.name ? (
          <Status theme={theme} loading={list.isPending} error={list.error} empty={list.data ? `本机记录中没有需求 ${params.name}。` : null} />
        ) : (
          <Text style={s.muted}>没有指定需求。</Text>
        )}
      </ScrollView>
    </View>
  );
}
