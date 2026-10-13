// Text the pipeline sends into the chat that launched it, and follow-ups it
// sends to step agents. Messages to the chat are read by that chat's agent, who
// relays them to the person who asked for the change (not a developer), so each one says what to tell the user
// and what to do next.

const HEADER =
  "【需求开发流水线通知】这条消息来自后台运行的开发流水线，不是用户发的。请把要点转告用户：讲需求和结果，不讲代码实现，除非用户问起。";

export function blockedMessage(input: {
  featureDir: string;
  questions: string[];
  resumeCommand: string;
  /** A reminder is scheduled after this many hours without an answer. */
  reminderHours?: number | null;
}): string {
  const list = input.questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  return [
    HEADER,
    "",
    `功能目录：${input.featureDir}`,
    "情况：方案审核发现有问题必须由需求方决定，否则可能做出错误的东西。流水线已暂停，还没有开始写代码。",
    "",
    "需要用户决定的问题：",
    list,
    "",
    "请这样处理：",
    "1. 按需求对齐时的方式，逐个向用户提问（给出选项和你的推荐）。",
    "2. 把答案记入功能目录下的 alignment.md，并更新 spec.md（顶部\"版本\"加 1，在 changes.md 中记录这次变更）。",
    "3. 把更新后的要点讲给用户听，请用户再次确认 spec（保持顶部为 \"- 状态：已确认\"，并更新日期）。",
    "4. 用户确认后执行下面的命令，流水线会从方案设计开始，在已有方案的基础上处理这些回答：",
    "",
    input.resumeCommand,
    ...(input.reminderHours ? ["", `（如果 ${input.reminderHours} 小时内还没有回答，会在这个对话里提醒一次。）`] : []),
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
    "如果这类等待经常出现，说明流水线配置中的 agent 模式还会询问权限，需要把配置中的 agent 改成免确认模式（运行 /req-doctor 可以查看当前配置）。",
  ].join("\n");
}

export function failedMessage(input: {
  stepTitle: string;
  reason: string;
  logPath: string;
  resumeCommand: string;
  /** An automatic continuation is scheduled at this time (text). */
  autoResumeAt?: string | null;
}): string {
  return [
    HEADER,
    "",
    `流水线在「${input.stepTitle}」步骤停止了。`,
    `原因：${input.reason}`,
    "",
    "已完成的步骤会保留。请告诉用户开发暂时中断，并说明原因。用户可以先看日志判断原因；涉及环境、配置或代码的问题请开发同事处理。",
    `日志：${input.logPath}`,
    ...(input.autoResumeAt
      ? [
          `这是临时错误（例如限流或网络中断），已预约在 ${input.autoResumeAt} 自动继续（Paseo 定时任务，到时会在这个对话里执行继续命令）。请告诉用户这一点；用户不想自动继续时，执行暂停命令即可取消。`,
          "也可以现在就执行下面的命令继续：",
        ]
      : ["问题解决后，执行下面的命令可以从中断的步骤继续："]),
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

export function specReviewMessage(input: { featureDir: string; verdict: string; issues: string[]; reviewPath: string }): string {
  if (input.verdict === "ready") {
    return [
      HEADER,
      "",
      `功能目录：${input.featureDir}`,
      `需求说明的独立审阅已完成：没有发现需要澄清的问题（详见 ${input.reviewPath}）。`,
      "请告诉用户这一点，然后继续请用户确认需求说明。",
    ].join("\n");
  }
  return [
    HEADER,
    "",
    `功能目录：${input.featureDir}`,
    `需求说明的独立审阅已完成：另一个模型发现 ${input.issues.length} 个建议在确认前澄清的问题，详见 ${input.reviewPath}（其中每个问题都写成了带选项和推荐的选择题）：`,
    "",
    ...input.issues.map((q, i) => `${i + 1}. ${q}`),
    "",
    "请这样处理：",
    "1. 先读审阅文件，自己核对一遍：不成立的问题直接略过，并在最后告诉用户略过了哪些、为什么。",
    "2. 成立的问题，按需求对齐时的方式一次一个地问用户（用审阅文件中的选项和推荐）。",
    "3. 把答案记入 alignment.md，更新 spec.md，再请用户确认需求说明。",
  ].join("\n");
}

export function specReviewFailedMessage(input: { featureDir: string; reason: string }): string {
  return [
    HEADER,
    "",
    `功能目录：${input.featureDir}`,
    `需求说明的独立审阅没有完成：${input.reason}`,
    "这不影响继续：请告诉用户审阅没能完成，然后照常请用户确认需求说明。",
  ].join("\n");
}

/** Sent by a Paseo schedule into the chat when a decision has been waited for a long time. */
export function waitingReminderMessage(input: { featureDir: string; hours: number; questions: string[]; resumeCommand: string }): string {
  return [
    "【需求开发流水线通知】这是一条预约的提醒，不是用户发的。",
    "",
    `功能目录：${input.featureDir}`,
    `这个需求在等需求方回答方案审核提出的问题，已经超过 ${input.hours} 小时，开发一直暂停着：`,
    ...input.questions.map((q, i) => `${i + 1}. ${q}`),
    "",
    "请先执行查看进度的命令确认：仍然是\"等待需求方决定\"时，在用户下次说话时提醒他这几个问题，并按之前的方式逐个询问；用户已经回答、开发已经继续或停止时，忽略这条提醒，不要打扰用户。",
    `回答完、更新需求说明后，继续的命令是：${input.resumeCommand}`,
  ].join("\n");
}

/** Sent by a Paseo schedule into the chat to continue after a transient error. */
export function autoResumePrompt(input: { featureDir: string; reason: string; statusCommand: string; resumeCommand: string }): string {
  return [
    "【需求开发流水线通知】这是一条预约的自动继续，不是用户发的。",
    "",
    `功能目录：${input.featureDir}`,
    `开发流水线之前因为临时错误中断：${input.reason}`,
    "",
    "请这样处理：",
    `1. 先执行查看进度的命令：${input.statusCommand}`,
    "2. 仍然是\"已中断，可以继续\"时，执行下面的继续命令，然后用一句话告诉用户已经自动继续：",
    `   ${input.resumeCommand}`,
    "3. 其他情况（已经在运行、已完成、用户已经手动处理过）：什么也不做，也不要回复用户。",
  ].join("\n");
}

/** Sent by a Paseo schedule into the chat while a pipeline runs (watchdogMinutes). */
export function watchdogPrompt(input: { featureDir: string; statusCommand: string; resumeCommand: string }): string {
  return [
    "【需求开发流水线通知】这是一条定时检查，不是用户发的。",
    "",
    `请执行查看进度的命令：${input.statusCommand}`,
    `- 输出中的状态是"已中断（后台进程意外退出，可以继续）"：执行继续命令 ${input.resumeCommand}，然后用一句话告诉用户开发在意外中断后已经自动继续。`,
    "- 其他任何情况：什么也不做，不要回复用户，不要打扰用户。",
    `（功能目录：${input.featureDir}。这个检查在流水线结束后会自动取消。）`,
  ].join("\n");
}

export function queuedMessage(input: { featureDir: string; max: number; holders: Array<{ featureDir: string; repo: string }> }): string {
  return [
    HEADER,
    "",
    `功能目录：${input.featureDir}`,
    `这台机器同时最多运行 ${input.max} 条开发流水线，现在已经满了，这个需求在排队，轮到时会自动开始并通知这个对话：`,
    ...input.holders.map((h) => `- 正在运行：${h.featureDir}（${h.repo}）`),
    "",
    "请把这一点告诉用户。不想等的话，可以执行暂停命令取消排队。",
  ].join("\n");
}

export function dequeuedMessage(input: { featureDir: string; waitedMinutes: number }): string {
  return [HEADER, "", `功能目录：${input.featureDir}`, `排队结束（等了约 ${Math.max(1, Math.round(input.waitedMinutes))} 分钟），开发已经开始。请用一句话告诉用户。`].join("\n");
}

export function scheduledStartPrompt(input: { featureDir: string; command: string }): string {
  return [
    "【需求开发流水线通知】这是用户之前预约的开发开始时间，不是用户现在发的消息。",
    "",
    `功能目录：${input.featureDir}`,
    "请执行下面的启动命令，然后用一句话告诉用户预约的开发已经开始（输出\"未启动\"时，按 /req 中的说明处理并告诉用户原因）：",
    "",
    input.command,
  ].join("\n");
}
