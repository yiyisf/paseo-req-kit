// req-kit 外部通知模板：接入企业内部 IM（或任何其他渠道）。
//
// 用法：
//   1. 复制到 ~/.req-kit/notifiers/im.mjs（或团队配置仓库中），按下面的 TODO 实现发送。
//   2. 在本机配置 ~/.req-kit/config.json（或团队配置）中加上：
//        "notifiers": [
//          { "module": "~/.req-kit/notifiers/im.mjs",
//            "events": ["blocked", "failed", "completed"],
//            "options": { "webhook": "https://im.example.internal/hook/xxxx" } }
//        ]
//      module 可以是绝对路径、"~/" 开头的路径，或相对配置文件所在目录的路径。
//      events 不写时发送全部五种事件：milestone、blocked、permission、failed、completed。
//   3. 在终端运行 `req notify-test`（或 `req notify-test --type blocked`）发一条测试通知，不需要运行流水线。
//
// 约定（详见 contracts/notifier-event.md）：
//   - 导出 default（或名为 notify 的）函数，参数为 (event, options)，可以是 async。
//   - 15 秒内没有完成按失败处理；抛出的错误只写进流水线日志，不影响流水线。
//   - 只能使用 Node.js 22 内置的能力（例如全局 fetch），req-kit 不会为它安装依赖。
//   - 不要把口令写在这个文件里：放在环境变量中，用 process.env 读取。

/**
 * @param {object} event     通知事件，字段见 contracts/notifier-event.md
 * @param {Record<string, unknown>} options  配置中的 options
 */
export default async function notify(event, options) {
  const title = {
    milestone: "进展",
    blocked: "需要你决定",
    permission: "等待批准",
    failed: "开发中断",
    completed: "开发完成",
    digest: "需求总览",
  }[event.type] ?? event.type;

  // 一条通用的纯文本消息，大多数 IM 机器人都能直接使用。
  // 需求总览（digest）的 text 已经是完整的多行文字。
  const lines = event.type === "digest" ? [event.text] : [`【req-kit · ${title}】${event.feature.title}`, event.text];
  if (event.type === "completed" && event.details.summary) lines.push("", String(event.details.summary));
  if (event.type === "blocked") lines.push("", ...event.details.questions.map((q, i) => `${i + 1}. ${q}`));
  if (event.type !== "digest") lines.push("", `需求目录：${event.feature.dir}${event.branch ? `（分支 ${event.branch}）` : ""}`);
  const text = lines.join("\n");

  // TODO：按企业内部 IM 的接口实现发送。例如一个接收 JSON 的群机器人：
  //
  // const response = await fetch(String(options.webhook), {
  //   method: "POST",
  //   headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.MY_IM_TOKEN}` },
  //   body: JSON.stringify({ msgtype: "text", text: { content: text } }),
  // });
  // if (!response.ok) throw new Error(`IM 返回 ${response.status}`);
  //
  // 还没有实现时，先什么也不做（流水线日志中会记录"外部通知已发送"）。
  // 用 req notify-test 测试时，把将要发送的内容打印出来，方便核对排版。
  if (process.env.REQ_KIT_NOTIFY_TEST === "1") console.log(`--- 将要发送的内容 ---\n${text}\n---------------------`);
  void options;
}
