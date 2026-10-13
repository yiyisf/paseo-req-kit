const UNITS = ["B", "KB", "MB", "GB"];

/** Formats a byte count, e.g. 1536 -> "1.5 KB". */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) throw new TypeError("bytes must be a non-negative number");
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(value) : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${UNITS[unit]}`;
}
