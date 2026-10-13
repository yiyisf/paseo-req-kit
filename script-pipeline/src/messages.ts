// Text the pipeline sends into the chat that launched it, and follow-ups it
// sends to step agents. Messages to the chat are read by that chat's agent, who
// relays them to a non-technical user, so each one says what to tell the user
// and what to do next.

const HEADER =
  "【需求开发流水线通知】这条消息来自后台运行的开发流水线，不是用户发的。请用业务语言把要点转告用户，不要提及技术细节，除非用户问起。";

export function blockedMessage(input: {
  featureDir: string;
  questions: string[];
  resumeCommand: string;
}): string {
  const list = input.questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  return [
    HEADER,
    "",
    `功能目录：${input.featureDir}`,
    "情况：方案审核发现有问题必须由业务方决定，否则可能做出错误的东西。流水线已暂停，还没有开始写代码。",
    "",
    "需要用户决定的问题：",
    list,
    "",
    "请这样处理：",
    "1. 按需求对齐时的方式，逐个向用户提问（给出选项和你的推荐）。",
    "2. 把答案记入功能目录下的 alignment.md，并更新 spec.md。",
    "3. 把更新后的要点讲给用户听，请用户再次确认 spec（保持顶部为 \"- 状态：已确认\"，并更新日期）。",
    "4. 用户确认后执行下面的命令，流水线会从方案设计重新开始：",
    "",
    input.resumeCommand,
  ].join("\n");
}

export function permissionMessage(input: {
  stepTitle: string;
  agentTitle: string;
  requests: string[];
}): string {
  return [
    HEADER,
    "",
    `流水线的「${input.stepTitle}」步骤在等待权限批准，批准前会一直停在这里：`,
    ...input.requests.map((r) => `- ${r}`),
    "",
    `请告诉用户：在 Paseo 中打开名为「${input.agentTitle}」的 agent，查看并批准这个请求（或拒绝）。`,
    "如果这类等待经常出现，说明流水线配置中的 agent 模式还会询问权限，需要请技术同事改成免确认模式。",
  ].join("\n");
}

export function failedMessage(input: {
  stepTitle: string;
  reason: string;
  logPath: string;
  resumeCommand: string;
}): string {
  return [
    HEADER,
    "",
    `流水线在「${input.stepTitle}」步骤停止了。`,
    `原因：${input.reason}`,
    "",
    "已完成的步骤会保留。请告诉用户开发暂时中断，并说明原因；这类问题通常需要技术同事看一下。",
    `日志：${input.logPath}`,
    "问题解决后，执行下面的命令可以从中断的步骤继续：",
    "",
    input.resumeCommand,
  ].join("\n");
}

const OUTCOME_TEXT: Record<string, string> = {
  completed: "已完成，可以验收",
  completed_with_issues: "已完成，但有遗留问题",
  not_completed: "未完成",
};

export function completedMessage(input: {
  featureDir: string;
  outcome: string;
  summary: string;
  reportPath: string;
}): string {
  return [
    HEADER,
    "",
    `需求开发流水线已经结束。结论：${OUTCOME_TEXT[input.outcome] ?? input.outcome}`,
    "",
    "摘要：",
    input.summary,
    "",
    `完整报告：${input.reportPath}`,
    "",
    "请把结论和摘要转告用户，并读一下报告中「需要你做的事」一节，提醒用户接下来要做什么。用户有疑问时，以报告和功能目录中的文件为准来回答。",
  ].join("\n");
}

export function resultFollowUp(input: { resultFile: string; problem: string }): string {
  return [
    `流水线没有拿到本步骤的有效结果：${input.problem}。`,
    `如果本步骤的工作还没有完成，请先完成它；然后按照"本步骤任务"中"结果文件"一节的要求，把结果写入 ${input.resultFile}（只含一个 JSON 对象），再结束。`,
  ].join("\n");
}

export function milestoneMessage(text: string): string {
  return [
    "【需求开发流水线通知 · 进展】这条消息来自后台流水线，不是用户发的。仅告知进展，用一句话转告用户即可，不需要其他操作。",
    "",
    text,
  ].join("\n");
}
