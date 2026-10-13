// External notifiers: local modules the engine calls at key events, in addition to
// the message it sends into the originating chat. This is the slot for an internal
// IM (or any other channel); see notifiers/im-template.mjs and contracts/notifier-event.md.
//
// A notifier never affects the pipeline: errors and timeouts are logged and ignored.

import { pathToFileURL } from "node:url";

export const NOTIFIER_EVENT_TYPES = ["milestone", "blocked", "permission", "failed", "completed", "digest"] as const;
export type NotifierEventType = (typeof NOTIFIER_EVENT_TYPES)[number];

export interface NotifierConfig {
  /** Absolute path of the module (resolved when the config is loaded). */
  module: string;
  /** Events to send; all of them when omitted. */
  events?: NotifierEventType[];
  /** Passed to the module as its second argument, e.g. a webhook address or a group ID. */
  options?: Record<string, unknown>;
}

export interface NotifierEvent {
  /** Format version of this object. */
  schema: 1;
  type: NotifierEventType;
  at: string;
  kitVersion: string;
  feature: { dir: string; name: string; title: string };
  repo: string;
  branch: string | null;
  profile: string;
  /** Chat agent the run reports to, if any. */
  originAgentId: string | null;
  /** One or two plain sentences, ready to post as is. */
  text: string;
  /** Type-specific fields; see contracts/notifier-event.md. */
  details: Record<string, unknown>;
}

export type NotifierFunction = (event: NotifierEvent, options: Record<string, unknown>) => unknown;

const TIMEOUT_MS = 15_000;

async function loadNotifier(file: string): Promise<NotifierFunction> {
  const module = (await import(pathToFileURL(file).href)) as { default?: unknown; notify?: unknown };
  const fn = module.default ?? module.notify;
  if (typeof fn !== "function") throw new Error(`${file} 没有导出 notify 函数（export default 或 export function notify）`);
  return fn as NotifierFunction;
}

/** Calls every configured notifier that wants this event. Never throws. */
export async function dispatchNotifiers(
  notifiers: NotifierConfig[],
  event: NotifierEvent,
  log: (message: string) => void,
): Promise<void> {
  const wanted = notifiers.filter((n) => !n.events || n.events.includes(event.type));
  await Promise.all(
    wanted.map(async (n) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const fn = await loadNotifier(n.module);
        await Promise.race([
          Promise.resolve(fn(event, n.options ?? {})),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`超过 ${TIMEOUT_MS / 1000} 秒没有完成`)), TIMEOUT_MS);
          }),
        ]);
        log(`外部通知已发送（${event.type}）：${n.module}`);
      } catch (error) {
        log(`外部通知失败（${event.type}，${n.module}）：${(error as Error).message}。不影响流水线。`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );
}
