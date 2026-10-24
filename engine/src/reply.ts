// `req reply <需求> <回复>` (1.12): passes an answer written in the plugin's inbox to the
// requirement's chat, which handles it as if the user had typed it there. Nothing else changes:
// the chat updates the requirement and continues the pipeline itself.
import { locate } from "./api.js";
import { DEFAULT_CONFIG, loadConfig, type PipelineConfig } from "./config.js";
import { defaultConfigPath } from "./locations.js";
import { pluginReplyMessage } from "./messages.js";
import { loadRuntimeFactory } from "./runtime-loader.js";
import { readIndex } from "./records.js";
import { readState, statePath } from "./state.js";

async function main(argvIn: string[]): Promise<number> {
  // 1.14 --acceptance: the checklist page found problems; the text is the whole notice.
  // 1.14 --notice: a notice of the background check (no run needed: the chat it was aligned in).
  const acceptance = argvIn.includes("--acceptance");
  const notice = argvIn.includes("--notice");
  const argv = argvIn.filter((a) => a !== "--acceptance" && a !== "--notice");
  const [feature, ...words] = argv;
  const text = words.join(" ").trim();
  if (!feature || !text) {
    console.error("用法：req reply <需求> <回复内容>");
    return 2;
  }
  const { repo, featureDir } = locate(process.cwd(), feature);
  const state = readState(statePath(repo, featureDir));
  if (notice) {
    const chat = state?.originAgentId ?? readIndex().find((e) => e.featureDir === featureDir && [e.repo, e.sourceRepo].includes(repo))?.chatAgentId ?? null;
    if (!chat) {
      console.error("这个需求没有登记过对话，没有可以转达的对话。");
      return 1;
    }
    return deliver(repo, chat, text.slice(0, 8000), "已转给这个需求的对话。");
  }
  if (!state || (!acceptance && state.status !== "waiting_for_business" && state.status !== "waiting_for_approval")) {
    console.error(`${featureDir} 现在没有在等待回答或确认，不用回复。`);
    return 1;
  }
  if (!state.originAgentId) {
    console.error("这个需求不是从 Paseo 对话中开始的，没有可以转达的对话。请在终端或卡片中处理。");
    return 1;
  }
  return deliver(
    repo,
    state.originAgentId,
    acceptance
      ? text.slice(0, 8000)
      : pluginReplyMessage({
          featureDir,
          waitingFor: state.status === "waiting_for_approval" ? "approval" : "business",
          text: text.slice(0, 8000),
          questions: state.pendingQuestions ?? [],
        }),
    acceptance ? "已转给这个需求的对话。" : "已转给这个需求的对话，它会按回复更新需求说明并继续开发。",
  );
}

async function deliver(repo: string, chat: string, message: string, done: string): Promise<number> {
  let config: PipelineConfig;
  try {
    config = loadConfig(defaultConfigPath(), repo).config;
  } catch {
    // Only the daemon address is needed here.
    config = DEFAULT_CONFIG;
  }
  const runtime = await (await loadRuntimeFactory())({ config, log: () => undefined });
  try {
    await runtime.notifyAgent(chat, message);
  } finally {
    await runtime.close().catch(() => undefined);
  }
  console.log(done);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: Error) => {
    console.error(`没有转达：${error.message}`);
    process.exit(1);
  },
);
