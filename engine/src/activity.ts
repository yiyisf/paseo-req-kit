// Turns an agent's Paseo timeline into a few plain-language lines for "做到哪了":
// what it ran, read or changed most recently. Shapes follow
// @getpaseo/protocol agent-types.ts (AgentTimelineItem, ToolCallDetail).

import type { ActivityItem } from "./runtime.js";

interface TimelineEntry {
  timestamp: string;
  item: unknown;
}

const clip = (text: string, max = 80) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

function shortPath(file: string): string {
  const parts = file.split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : parts.join("/");
}

function describeTool(item: Record<string, unknown>): string | null {
  const detail = (item.detail ?? {}) as Record<string, unknown>;
  const failed = item.status === "failed" ? "（失败）" : "";
  switch (detail.type) {
    case "shell":
      return `运行命令：${clip(String(detail.command ?? ""))}${failed}`;
    case "read":
      return `阅读 ${shortPath(String(detail.filePath ?? ""))}`;
    case "edit":
      return `修改 ${shortPath(String(detail.filePath ?? ""))}${failed}`;
    case "write":
      return `写入 ${shortPath(String(detail.filePath ?? ""))}${failed}`;
    case "search":
      return `搜索：${clip(String(detail.query ?? ""), 50)}`;
    case "fetch":
      return `访问 ${clip(String(detail.url ?? ""), 60)}`;
    case "sub_agent":
      return `子任务：${clip(String(detail.description ?? detail.subAgentType ?? ""), 60)}`;
    default: {
      const name = String(item.name ?? "");
      if (name.startsWith("browser_")) return `操作浏览器（${name.slice("browser_".length)}）`;
      return name ? `使用工具 ${name}${failed}` : null;
    }
  }
}

function describeItem(item: unknown): string | null {
  if (typeof item !== "object" || item === null) return null;
  const it = item as Record<string, unknown>;
  switch (it.type) {
    case "tool_call":
      return describeTool(it);
    case "assistant_message":
      return typeof it.text === "string" && it.text.trim() ? `说明：${clip(it.text)}` : null;
    case "todo": {
      const items = Array.isArray(it.items) ? (it.items as Array<{ completed?: boolean }>) : [];
      return items.length ? `待办清单：完成 ${items.filter((t) => t.completed).length}/${items.length}` : null;
    }
    case "error":
      return `出错：${clip(String(it.message ?? ""))}`;
    default:
      return null;
  }
}

/** The last `limit` describable entries, oldest first, with repeats of the same line collapsed. */
export function summarizeActivity(entries: TimelineEntry[], limit: number): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const entry of entries) {
    const text = describeItem(entry.item);
    if (!text) continue;
    if (out.at(-1)?.text === text) out[out.length - 1] = { at: entry.timestamp, text };
    else out.push({ at: entry.timestamp, text });
  }
  return out.slice(-limit);
}

/** Lines for the status output, e.g. "  10:42 运行命令：npm test". */
export function describeActivity(items: ActivityItem[], now = new Date()): string[] {
  return items.map((a) => {
    const at = new Date(a.at);
    const minutes = Math.round((now.getTime() - at.getTime()) / 60_000);
    const when = Number.isNaN(minutes) ? "" : minutes < 1 ? "刚刚" : minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`;
    return `  ${when ? `${when}：` : ""}${a.text}`;
  });
}
