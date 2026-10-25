// A small Markdown renderer for the requirement documents (spec, design, report…): headings,
// paragraphs, lists, task lists, tables, code blocks, quotes, rules, and inline bold, code and
// links. React Native only, colors from the theme, so it reads the same on desktop, web and phones.
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { rk } from "./ui";

type Theme = PluginHostProps["theme"];

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: Array<{ text: string; depth: number; checked: boolean | null }> }
  | { kind: "code"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "rule" };

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/;

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .replace(/\\\|/g, "\u0000")
    .split("|")
    .map((c) => c.trim().replace(/\u0000/g, "|"));
}

/** A tab-separated file (decisions.tsv, lessons.tsv) as a Markdown table. */
export function tsvToMarkdown(tsv: string): string {
  const rows = tsv.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
  if (rows.length === 0) return "";
  const line = (r: string) => `| ${r.split("\t").map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
  return [line(rows[0]), `|${rows[0].split("\t").map(() => " --- ").join("|")}|`, ...rows.slice(1).map(line)].join("\n");
}

/** Splits Markdown into blocks. Anything it does not recognise stays a paragraph. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines.at(i)!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines.at(i)!.trim().startsWith(fence[1])) body.push(lines.at(i++)!);
      i++;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    if (line.trim().startsWith("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines.at(i + 1)!)) {
      const header = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines.at(i)!.trim().startsWith("|")) rows.push(cells(lines.at(i++)!));
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines.at(i)!)) body.push(lines.at(i++)!.replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", text: body.join("\n") });
      continue;
    }
    if (LIST.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: Array<{ text: string; depth: number; checked: boolean | null }> = [];
      while (i < lines.length) {
        const m = LIST.exec(lines.at(i)!);
        if (m) {
          items.push({ text: m[4], depth: Math.min(3, Math.floor(m[1].replace(/\t/g, "    ").length / 2)), checked: m[3] ? /x/i.test(m[3]) : null });
          i++;
        } else if (lines.at(i)!.trim() && /^\s{2,}/.test(lines.at(i)!) && items.length > 0) {
          items.at(-1)!.text += ` ${lines.at(i++)!.trim()}`;
        } else break;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const body: string[] = [];
    while (i < lines.length && lines.at(i)!.trim() && !/^(#{1,6}\s|\s*```|\s*~~~|\s*>|\s*\|)/.test(lines.at(i)!) && !LIST.test(lines.at(i)!)) body.push(lines.at(i++)!.trim());
    blocks.push({ kind: "paragraph", text: body.join(" ") });
  }
  return blocks;
}

/** Inline **bold**, `code` and [links](https://…). */
export function inline(text: string, theme: Theme, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  let n = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] !== undefined) {
      out.push(
        <Text key={`${key}-${n++}`} style={{ fontWeight: "600" }}>
          {m[2]}
        </Text>,
      );
    } else if (m[3] !== undefined) {
      out.push(
        <Text key={`${key}-${n++}`} style={{ fontFamily: "monospace", backgroundColor: theme.colors.surface2 }}>
          {m[3]}
        </Text>,
      );
    } else if (m[5] && /^https?:\/\//.test(m[5])) {
      out.push(
        <ExternalLink key={`${key}-${n++}`} href={m[5]}>
          {m[4]}
        </ExternalLink>,
      );
    } else {
      // A link to another file in the repository: show its text and where it points.
      out.push(
        <Text key={`${key}-${n++}`} style={{ color: rk(theme).brandText }}>
          {m[4]}
        </Text>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ theme, source }: { theme: Theme; source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const text = { color: theme.colors.foreground, fontSize: 14, lineHeight: 21 };
  const muted = { color: theme.colors.foregroundMuted };
  return (
    <View style={{ gap: 10 }}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "heading":
            return (
              <Text key={i} selectable style={{ ...text, fontWeight: "600", fontSize: b.level === 1 ? 20 : b.level === 2 ? 17 : 15, marginTop: i === 0 ? 0 : 6 }}>
                {inline(b.text, theme, `h${i}`)}
              </Text>
            );
          case "paragraph":
            return (
              <Text key={i} selectable style={text}>
                {inline(b.text, theme, `p${i}`)}
              </Text>
            );
          case "list":
            return (
              <View key={i} style={{ gap: 4 }}>
                {b.items.map((item, j) => (
                  <View key={j} style={{ flexDirection: "row", gap: 6, paddingLeft: item.depth * 16 }}>
                    <Text style={{ ...text, ...muted, minWidth: 16 }}>{item.checked === null ? (b.ordered ? `${j + 1}.` : "•") : item.checked ? "☑" : "☐"}</Text>
                    <Text selectable style={{ ...text, flex: 1 }}>
                      {inline(item.text, theme, `l${i}-${j}`)}
                    </Text>
                  </View>
                ))}
              </View>
            );
          case "code":
            return (
              <ScrollView key={i} horizontal style={{ backgroundColor: theme.colors.surface2, borderRadius: 8 }}>
                <Text selectable style={{ ...text, fontFamily: "monospace", fontSize: 13, padding: 10 }}>
                  {b.text}
                </Text>
              </ScrollView>
            );
          case "quote":
            return (
              <View key={i} style={{ borderLeftWidth: 3, borderLeftColor: theme.colors.border, paddingLeft: 10 }}>
                <Text selectable style={{ ...text, ...muted }}>
                  {inline(b.text, theme, `q${i}`)}
                </Text>
              </View>
            );
          case "rule":
            return <View key={i} style={{ height: 1, backgroundColor: theme.colors.border }} />;
          case "table":
            return (
              <ScrollView key={i} horizontal>
                <View style={{ borderColor: theme.colors.border, borderWidth: 1, borderRadius: 6 }}>
                  {[b.header, ...b.rows].map((row, r) => (
                    <View key={r} style={{ flexDirection: "row", backgroundColor: r === 0 ? theme.colors.surface1 : undefined, borderTopWidth: r === 0 ? 0 : 1, borderTopColor: theme.colors.border }}>
                      {b.header.map((_, c) => (
                        <Text key={c} selectable style={{ ...text, fontSize: 13, fontWeight: r === 0 ? "600" : "400", width: 180, padding: 8 }}>
                          {inline(row.at(c) ?? "", theme, `t${i}-${r}-${c}`)}
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              </ScrollView>
            );
        }
        return null;
      })}
    </View>
  );
}
