// Times for Paseo schedules: parsing what people type ("22:00", "明天 8:30", "+2h")
// and turning a moment into a one-shot cron expression in the local time zone.

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** "M H D Mon *" for one moment (the schedule is limited to one run). */
export function cronAt(at: Date): string {
  return `${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *`;
}

/** Every N minutes, as cron: minutes under an hour, otherwise whole hours. */
export function cronEvery(minutes: number): string {
  if (minutes < 60) return `*/${Math.max(5, Math.round(minutes))} * * * *`;
  return `0 */${Math.min(23, Math.max(1, Math.round(minutes / 60)))} * * *`;
}

/**
 * Accepts "22:00" (today, or tomorrow when already past), "明天 8:30" / "tomorrow 8:30",
 * "2026-10-14 08:30", "+90m", "+2h". Returns null when it cannot be read.
 */
export function parseStartTime(text: string, now = new Date()): Date | null {
  const t = text.trim();
  const rel = /^\+\s*(\d+(?:\.\d+)?)\s*(m|min|分钟|h|小时)$/i.exec(t);
  if (rel) {
    const n = Number(rel[1]);
    const minutes = /^(m|min|分钟)$/i.test(rel[2]) ? n : n * 60;
    return new Date(now.getTime() + Math.round(minutes * 60_000));
  }
  const full = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/.exec(t);
  if (full) {
    const d = new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]), Number(full[4]), Number(full[5]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const clock = /^(今天|明天|today|tomorrow)?\s*(\d{1,2})[:：](\d{2})$/i.exec(t);
  if (clock) {
    const h = Number(clock[2]);
    const m = Number(clock[3]);
    if (h > 23 || m > 59) return null;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
    const tomorrow = /^(明天|tomorrow)$/i.test(clock[1] ?? "");
    if (tomorrow || (!clock[1] && d.getTime() <= now.getTime())) d.setDate(d.getDate() + 1);
    return d;
  }
  return null;
}

export function describeTime(at: Date): string {
  return at.toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
