// req-kit accent colors for the Paseo plugin, generated from design/tokens.json by scripts/tokens-build.mjs. Do not edit.
export const RK_COLORS = {
  "dark": {
    "brand500": "#a8e01f",
    "brand400": "#bdeb4a",
    "brandEdge": "#a8e01f",
    "brandText": "#c2ee55",
    "brandTint": "#a8e01f24",
    "onBrand": "#0f1a02",
    "ai": "#a5b4fc",
    "aiTint": "#818cf81f",
    "data": "#22d3ee",
    "dataTint": "#22d3ee1f",
    "successTint": "#34d3991f",
    "warningTint": "#fbbf241f",
    "failedTint": "#fb71851f"
  },
  "light": {
    "brand500": "#a8e01f",
    "brand400": "#b3e536",
    "brandEdge": "#65a30d",
    "brandText": "#466f0f",
    "brandTint": "#a8e01f2e",
    "onBrand": "#0f1a02",
    "ai": "#4f46e5",
    "aiTint": "#4f46e514",
    "data": "#0e7490",
    "dataTint": "#0e749014",
    "successTint": "#04785714",
    "warningTint": "#92400e14",
    "failedTint": "#be123c14"
  }
} as const;

export type RkColors = (typeof RK_COLORS)["dark"];
