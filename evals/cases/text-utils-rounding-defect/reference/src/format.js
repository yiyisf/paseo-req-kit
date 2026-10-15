const UNITS = ["B", "KB", "MB", "GB"];

/** Formats a byte count, e.g. 1536 -> "1.5 KB". */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) throw new TypeError("bytes must be a non-negative number");
  let value = bytes;
  let unit = 0;
  // Compare the value as it will be shown: 1023.96 KB is shown as "1024", so it belongs to the next unit.
  while (unit < UNITS.length - 1 && (unit === 0 ? value : Number(value.toFixed(1))) >= 1024) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(value) : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${UNITS[unit]}`;
}
