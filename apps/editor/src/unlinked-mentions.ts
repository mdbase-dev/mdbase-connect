import { markdownLanguage } from "@codemirror/lang-markdown";
import type { NoteSearchEntry, SearchTextRange } from "./note-search";
import { markdownPlainText } from "./note";
import type { NoteSummary } from "./model";

export interface UnlinkedMention {
  note: NoteSummary;
  body: string;
  from: number;
  to: number;
  snippet: string;
  snippetRanges: SearchTextRange[];
}
type TextRange = { from: number; to: number };
const contexts = new WeakMap<NoteSearchEntry, { excluded: TextRange[]; paragraphs: TextRange[] }>();
function mentionContext(entry: NoteSearchEntry) {
  const cached = contexts.get(entry);
  if (cached) return cached;
  const excluded: TextRange[] = [];
  const paragraphs: TextRange[] = [];
  markdownLanguage.parser.parse(entry.bodyText).iterate({ enter(node) {
    if (node.name === "Paragraph") paragraphs.push({ from: node.from, to: node.to });
    if (["ATXHeading1", "SetextHeading1", "Link", "Image", "Autolink", "InlineCode", "FencedCode", "CodeBlock", "HTMLBlock", "LinkReference"].includes(node.name)) {
      // Wiki syntax is an inner Link in CommonMark. Exclude the outer brackets too.
      const wiki = node.name === "Link" && entry.bodyText[node.from - 1] === "[" && entry.bodyText[node.to] === "]";
      excluded.push({ from: wiki ? node.from - 1 : node.from, to: wiki ? node.to + 1 : node.to });
      return false;
    }
  } });
  const context = { excluded, paragraphs };
  contexts.set(entry, context);
  return context;
}
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordEnd = "(?![\\p{L}\\p{N}_])";

/** Uses hydrated search entries only: discovery never issues collection reads. */
export function unlinkedMentions(index: NoteSearchEntry[], targetPath: string, title: string): UnlinkedMention[] {
  if (!title.trim()) return [];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapePattern(title)}${wordEnd}`, "giu");
  return index.flatMap((entry) => {
    if (entry.note.path === targetPath || !entry.bodyText) return [];
    pattern.lastIndex = 0;
    if (!pattern.test(entry.bodyText)) return [];
    const { excluded, paragraphs } = mentionContext(entry);
    const sourceTitle = markdownPlainText(entry.titleText);
    const longerSourceTitle = sourceTitle.length > title.length && new RegExp(`^${escapePattern(title)}${wordEnd}`, "iu").test(sourceTitle)
      ? new RegExp(`^${escapePattern(sourceTitle)}${wordEnd}`, "iu") : undefined;
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(entry.bodyText))) {
      const from = match.index, to = from + match[0].length;
      if (excluded.some((range) => from < range.to && to > range.from)) continue;
      // Clean the complete paragraph before excerpting so clipped Markdown
      // destinations/emphasis never leak into the snippet. Source offsets stay raw.
      const paragraph = paragraphs.find((range) => from >= range.from && to <= range.to) ?? { from, to };
      const raw = entry.bodyText.slice(paragraph.from, paragraph.to);
      // Temporary delimiters let the shared Markdown cleaner project the exact
      // occurrence into display offsets (including emphasis and Unicode). They
      // never enter persisted text, and cannot collide with source content.
      let marker: string;
      do { marker = `\uE000${crypto.randomUUID()}\uE001`; } while (raw.includes(marker));
      const marked = markdownPlainText(`${raw.slice(0, from - paragraph.from)}${marker}${match[0]}${marker}${raw.slice(to - paragraph.from)}`);
      const anchor = marked.indexOf(marker), endMarker = marked.indexOf(marker, anchor + marker.length);
      const phrase = marked.slice(anchor + marker.length, endMarker);
      const plain = marked.replaceAll(marker, "");
      if (anchor < 0 || endMarker < 0 || !phrase || longerSourceTitle?.test(plain.slice(anchor))) continue;
      const start = Math.max(0, anchor - 40), end = Math.min(plain.length, anchor + phrase.length + 65);
      const leading = start ? "…" : "";
      const snippet = `${leading}${plain.slice(start, end)}${end < plain.length ? "…" : ""}`;
      return [{ note: entry.note, body: entry.bodyText, from, to, snippet,
        snippetRanges: [{ from: leading.length + anchor - start, to: leading.length + anchor - start + phrase.length }] }];
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
