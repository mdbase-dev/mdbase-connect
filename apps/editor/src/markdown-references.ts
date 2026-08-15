import { markdownLanguage } from "@codemirror/lang-markdown";

export type MarkdownReferenceKind = "link" | "embed";
export type MarkdownReferenceFormat = "wikilink" | "markdown";

export interface MarkdownReference {
  from: number;
  to: number;
  target: string;
  label?: string;
  anchor?: string;
  kind: MarkdownReferenceKind;
  format: MarkdownReferenceFormat;
  block: boolean;
}

type MarkdownTree = ReturnType<typeof markdownLanguage.parser.parse>;

/**
 * Extracts portable Markdown and wiki references from the Markdown syntax tree.
 * Code spans and fenced code are ignored because they never produce Link/Image
 * nodes. Wiki embeds are parsed as Image nodes by the common Markdown grammar.
 */
export function markdownReferences(source: string, tree: MarkdownTree = markdownLanguage.parser.parse(source)): MarkdownReference[] {
  const references: MarkdownReference[] = [];
  const cursor = tree.cursor();
  const visit = () => {
    const kind = cursor.name === "Image" ? "embed" : cursor.name === "Link" ? "link" : undefined;
    if (kind) {
      // CodeMirror represents [[wikilinks]] as a Link containing only the inner
      // [target] range. Recover the outer bracket pair while retaining the syntax
      // tree's exclusion of code spans and fenced code.
      const wrappedWikiLink = kind === "link"
        && !cursor.node.getChild("URL")
        && cursor.from > 0
        && source[cursor.from - 1] === "["
        && source[cursor.to] === "]";
      const from = wrappedWikiLink ? cursor.from - 1 : cursor.from;
      const to = wrappedWikiLink ? cursor.to + 1 : cursor.to;
      const raw = source.slice(from, to);
      const parsed = raw.startsWith(kind === "embed" ? "![[" : "[[")
        ? parseWikiReference(raw, kind)
        : parseMarkdownReference(source, cursor.node, kind);
      if (parsed) {
        references.push({
          from,
          to,
          ...parsed,
          block: isBlockReference(source, from, to)
        });
      }
      // Image nodes contain a nested Link node in the CommonMark tree.
      if (kind === "embed") return;
    }
    if (cursor.firstChild()) {
      do visit(); while (cursor.nextSibling());
      cursor.parent();
    }
  };
  visit();
  return references;
}

export function markdownReferenceAt(
  source: string,
  position: number,
  kind?: MarkdownReferenceKind,
  tree?: MarkdownTree
): MarkdownReference | undefined {
  return markdownReferences(source, tree).find((reference) => (
    (!kind || reference.kind === kind)
    && position >= reference.from
    && position <= reference.to
  ));
}

function parseWikiReference(
  raw: string,
  kind: MarkdownReferenceKind
): Pick<MarkdownReference, "target" | "label" | "anchor" | "kind" | "format"> | undefined {
  const opening = kind === "embed" ? 3 : 2;
  if (!raw.endsWith("]]")) return undefined;
  const [rawTarget, rawLabel] = raw.slice(opening, -2).split("|", 2);
  const hash = rawTarget.indexOf("#");
  const target = (hash < 0 ? rawTarget : rawTarget.slice(0, hash)).trim();
  const anchor = hash < 0 ? undefined : rawTarget.slice(hash + 1).trim() || undefined;
  if (!target && !anchor) return undefined;
  const label = rawLabel?.trim() || undefined;
  return { target, ...(label ? { label } : {}), ...(anchor ? { anchor } : {}), kind, format: "wikilink" };
}

function parseMarkdownReference(
  source: string,
  node: ReturnType<MarkdownTree["resolve"]>,
  kind: MarkdownReferenceKind
): Pick<MarkdownReference, "target" | "label" | "anchor" | "kind" | "format"> | undefined {
  const url = node.getChild("URL");
  if (!url) return undefined;
  const rawTarget = source.slice(url.from, url.to).replace(/^<|>$/g, "").trim();
  if (!rawTarget) return undefined;
  const hash = rawTarget.indexOf("#");
  const target = (hash < 0 ? rawTarget : rawTarget.slice(0, hash)).trim();
  const anchor = hash < 0 ? undefined : rawTarget.slice(hash + 1).trim() || undefined;
  if (!target && !anchor) return undefined;

  const prefix = source.slice(node.from, url.from);
  const close = prefix.lastIndexOf("](");
  const labelFrom = kind === "embed" ? 2 : 1;
  const label = close >= labelFrom
    ? prefix.slice(labelFrom, close).replaceAll("\\]", "]").trim() || undefined
    : undefined;
  return { target, ...(label ? { label } : {}), ...(anchor ? { anchor } : {}), kind, format: "markdown" };
}

function isBlockReference(source: string, from: number, to: number): boolean {
  const lineStart = source.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
  const lineEndIndex = source.indexOf("\n", to);
  const lineEnd = lineEndIndex < 0 ? source.length : lineEndIndex;
  return source.slice(lineStart, from).trim() === "" && source.slice(to, lineEnd).trim() === "";
}
