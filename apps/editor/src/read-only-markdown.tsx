import { createElement, useMemo, type ReactNode } from "react";
import { markdownLanguage } from "@codemirror/lang-markdown";

// Bounds apply only to presentation, AFTER the store verifies the whole file.
// Bound parsing input, React node count and nesting independently.
const MAX_EXCERPT_CHARACTERS = 32_768;
const MAX_NODES = 2_048;
const MAX_DEPTH = 32;
const tags: Readonly<Record<string, string>> = {
  Paragraph: "p", Blockquote: "blockquote", BulletList: "ul", OrderedList: "ol", ListItem: "li",
  Emphasis: "em", StrongEmphasis: "strong", InlineCode: "code",
  ATXHeading1: "h1", ATXHeading2: "h2", ATXHeading3: "h3", ATXHeading4: "h4", ATXHeading5: "h5", ATXHeading6: "h6",
  SetextHeading1: "h1", SetextHeading2: "h2"
};
const marks = new Set(["HeaderMark", "QuoteMark", "ListMark", "EmphasisMark", "CodeMark"]);

/** No editor, application resolvers, HTML interpreter, URLs, or mutation hooks.
 * Only allowlisted structural nodes become DOM; everything else is escaped text.
 * Links/images/wiki references/tasks deliberately retain their inert source form.
 */
function renderExcerpt(source: string): { content: ReactNode; truncated: boolean } {
  // Do not split a UTF16 surrogate pair at the excerpt boundary.
  let end = Math.min(source.length, MAX_EXCERPT_CHARACTERS);
  if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1])) end -= 1;
  const excerpt = source.slice(0, end);
  const tree = markdownLanguage.parser.parse(excerpt);
  const cursor = tree.cursor();
  let remaining = MAX_NODES;
  let truncated = end < source.length;

  function node(depth: number): ReactNode {
    if (remaining-- <= 0 || depth > MAX_DEPTH) {
      truncated = true;
      return null;
    }
    const { name, from, to } = cursor;
    if (marks.has(name)) return null;
    if (name === "HorizontalRule") return <hr key={from} />;
    if (name === "HardBreak") return <br key={from} />;
    if (name === "FencedCode" || name === "CodeBlock") {
      // A code block emits two elements rather than one.
      if (remaining-- <= 0) { truncated = true; return null; }
      const text = cursor.node.getChild("CodeText");
      return <pre key={from}><code>{text ? excerpt.slice(text.from, text.to) : excerpt.slice(from, to)}</code></pre>;
    }
    const tag = tags[name];
    if (!tag && name !== "Document") return excerpt.slice(from, to);
    const children: ReactNode[] = [];
    let position = from;
    if (cursor.firstChild()) {
      do {
        if (remaining <= 0) { truncated = true; break; }
        if (cursor.from > position) children.push(excerpt.slice(position, cursor.from));
        children.push(node(depth + 1));
        position = cursor.to;
      } while (cursor.nextSibling());
      cursor.parent();
    }
    if (remaining > 0 && position < to) children.push(excerpt.slice(position, to));
    return tag ? createElement(tag, { key: from }, ...children) : children;
  }
  return { content: node(0), truncated };
}

export function ReadOnlyMarkdown({ source, byteLength }: { source: string; byteLength: number }) {
  const { content, truncated } = useMemo(() => renderExcerpt(source), [source]);
  return <section className="read-only-markdown" role="region" aria-label="Read-only Markdown preview" tabIndex={0}>
    <p className="read-only-markdown-notice">Read-only Markdown preview</p>
    {byteLength > 1_048_576 && <p className="read-only-markdown-notice">Notes larger than 1 MiB are read-only at launch.</p>}
    {truncated && <p className="read-only-markdown-notice">Preview truncated for display. The whole verified original is available using Open original.</p>}
    <div className="read-only-markdown-body">{content}</div>
  </section>;
}
