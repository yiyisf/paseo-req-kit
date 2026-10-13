const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Formats a byte count, e.g. 1536 -> "1.5 KB". */
export function formatBytes(bytes, options = {}) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) throw new TypeError("bytes must be a finite number");
  const explicit = options.decimals !== undefined;
  const decimals = explicit ? options.decimals : 1;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 3) throw new RangeError("decimals must be an integer from 0 to 3");
  const sign = bytes < 0 ? "-" : "";
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  let text = unit === 0 ? String(value) : value.toFixed(decimals);
  if (!explicit && unit > 0) text = text.replace(/\.0$/, "");
  return `${sign}${text} ${UNITS[unit]}`;
}
