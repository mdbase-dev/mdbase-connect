import { markdownLanguage } from "@codemirror/lang-markdown";
import type { NoteSearchEntry } from "./note-search";
import type { NoteSummary } from "./model";

export interface UnlinkedMention {
  note: NoteSummary;
  body: string;
  from: number;
  to: number;
  snippet: string;
}
const exclusions = new WeakMap<NoteSearchEntry, Array<{ from: number; to: number }>>();
function excludedRanges(entry: NoteSearchEntry) {
  const cached = exclusions.get(entry);
  if (cached) return cached;
  const ranges: Array<{ from: number; to: number }> = [];
  markdownLanguage.parser.parse(entry.bodyText).iterate({ enter(node) {
    if (["Link", "Image", "Autolink", "InlineCode", "FencedCode", "CodeBlock", "HTMLBlock", "LinkReference"].includes(node.name)) {
      // Wiki syntax is an inner Link in CommonMark. Exclude the outer brackets too.
      const wiki = node.name === "Link" && entry.bodyText[node.from - 1] === "[" && entry.bodyText[node.to] === "]";
      ranges.push({ from: wiki ? node.from - 1 : node.from, to: wiki ? node.to + 1 : node.to });
      return false;
    }
  } });
  exclusions.set(entry, ranges);
  return ranges;
}

/** Uses hydrated search entries only: discovery never issues collection reads. */
export function unlinkedMentions(index: NoteSearchEntry[], targetPath: string, title: string): UnlinkedMention[] {
  if (!title.trim()) return [];
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu");
  return index.flatMap((entry) => {
    if (entry.note.path === targetPath || !entry.bodyText) return [];
    pattern.lastIndex = 0;
    if (!pattern.test(entry.bodyText)) return [];
    const ranges = excludedRanges(entry);
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(entry.bodyText))) {
      const from = match.index, to = from + match[0].length;
      if (ranges.some((range) => from < range.to && to > range.from)) continue;
      const start = Math.max(0, from - 40), end = Math.min(entry.bodyText.length, to + 65);
      return [{ note: entry.note, body: entry.bodyText, from, to,
        snippet: `${start ? "…" : ""}${entry.bodyText.slice(start, end).replace(/\s+/g, " ")}${end < entry.bodyText.length ? "…" : ""}` }];
    }
    return [];
  });
}
export function linkMention(mention: UnlinkedMention, targetPath: string, body: string): { body: string; inserted: string } {
  if (body !== mention.body) throw new Error("That note changed. Find its mentions again before linking.");
  const target = targetPath.replace(/\.md$/i, "").replace(/[|\[\]#%]/g, (char) => encodeURIComponent(char));
  const label = body.slice(mention.from, mention.to);
  // A delimiter-bearing title is still linkable by its encoded durable target.
  const inserted = /[|\[\]\r\n]/.test(label) ? `[[${target}]]` : `[[${target}|${label}]]`;
  return { body: body.slice(0, mention.from) + inserted + body.slice(mention.to), inserted };
}
