import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, Prec, type EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

/**
 * Rich text pasted from a web page or a document becomes Markdown: its headings,
 * links, emphasis, lists, quotes, code and images survive instead of collapsing
 * into plain text. It runs after the specialist paste handlers (files, tables,
 * a URL over a selection), and pastes into code or a table stay plain.
 */
export const htmlPaste: Extension = Prec.low(EditorView.domEventHandlers({
  paste(event, view) {
    const data = event.clipboardData;
    if (view.state.readOnly || !data) return false;
    const html = data.getData("text/html");
    if (!html || insideCodeOrTable(view.state)) return false;
    const markdown = htmlToMarkdown(html);
    if (markdown === null) return false;
    event.preventDefault();
    view.dispatch(view.state.changeByRange((range) => {
      const insert = onOwnLines(view.state, range.from, range.to, markdown);
      return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length) };
    }), { scrollIntoView: true, userEvent: "input.paste" });
    return true;
  }
}));

function insideCodeOrTable(state: EditorState): boolean {
  return state.selection.ranges.some((range) => {
    const tree = ensureSyntaxTree(state, range.head, 50) ?? syntaxTree(state);
    for (let node: SyntaxNode | null = tree.resolveInner(range.head, -1); node; node = node.parent) {
      if (/^(?:FencedCode|CodeBlock|InlineCode|Table)$/.test(node.name)) return true;
    }
    return false;
  });
}

/** Blocks pasted mid-line start and end on their own lines, so a heading or list stays one. */
function onOwnLines(state: EditorState, from: number, to: number, markdown: string): string {
  if (!/\n/.test(markdown) && !BLOCK_START.test(markdown)) return markdown;
  const before = state.sliceDoc(state.doc.lineAt(from).from, from);
  const after = state.sliceDoc(to, state.doc.lineAt(to).to);
  return `${before.trim() ? "\n\n" : ""}${markdown}${after.trim() ? "\n\n" : ""}`;
}

const BLOCK_START = /^(?:#{1,6} |[-*+] |\d+[.)] |> |```|\|)/;
const DROPPED = "script, style, template, noscript, meta, link, title, head, iframe, object, svg, canvas, button, select, textarea";
// Only HTML that says something Markdown can is converted; anything else pastes as the clipboard's own text.
const MEANINGFUL = "h1, h2, h3, h4, h5, h6, a[href], strong, b, em, i, code, pre, ul, ol, blockquote, img[src], hr, table, del, s, strike, span[style]";
const BLOCKS = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "DD", "DETAILS", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE", "FOOTER", "FORM",
  "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "UL"]);

/** Markdown for clipboard HTML, or null when it carries nothing beyond plain text. */
export function htmlToMarkdown(html: string): string | null {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  for (const element of body.querySelectorAll(DROPPED)) element.remove();
  // Code editors copy coloured runs inside a preformatted block that is not a <pre>: their text is the content.
  // (Google Docs marks its spans pre-wrap, which is prose.)
  if ([...body.querySelectorAll("[style]")].some((element) => element.tagName !== "SPAN"
      && /white-space\s*:\s*pre\s*(?:;|$)/i.test(element.getAttribute("style") ?? ""))) return null;
  if (![...body.querySelectorAll(MEANINGFUL)].some(meaningful)) return null;
  const markdown = renderBlocks(body).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  return markdown || null;
}

function meaningful(element: Element): boolean {
  if (element.tagName === "SPAN") return Boolean(styleMark(element));
  // Google Docs wraps its whole selection in a <b> that is not bold.
  if (element.tagName === "B") return !notBold(element);
  return true;
}

function notBold(element: Element): boolean {
  return /font-weight\s*:\s*(?:normal|[1-4]00)\b/i.test(element.getAttribute("style") ?? "");
}

/** Emphasis a styled span stands for, as Google Docs and Word mark it. */
function styleMark(element: Element): string {
  const style = element.getAttribute("style") ?? "";
  let mark = "";
  if (/font-weight\s*:\s*(?:bold|[6-9]00)\b/i.test(style)) mark += "**";
  if (/font-style\s*:\s*italic/i.test(style)) mark += "*";
  if (/text-decoration[^;]*line-through/i.test(style)) mark += "~~";
  return mark;
}

function renderBlocks(parent: Element): string[] {
  const blocks: string[] = [];
  let run = "";
  const flush = () => {
    const paragraph = tidy(run);
    if (paragraph) blocks.push(escapeBlockStart(paragraph));
    run = "";
  };
  for (const node of parent.childNodes) {
    if (node instanceof Element && BLOCKS.has(node.tagName)) {
      flush();
      blocks.push(...renderBlock(node));
    } else {
      run += renderInline(node);
    }
  }
  flush();
  return blocks.filter(Boolean);
}

function renderBlock(element: Element): string[] {
  const tag = element.tagName;
  if (/^H[1-6]$/.test(tag)) {
    const text = tidy(renderInline(element)).replace(/\n+/g, " ");
    return text ? [`${"#".repeat(Number(tag[1]))} ${text}`] : [];
  }
  if (tag === "HR") return ["---"];
  if (tag === "PRE") return [codeBlock(element)];
  if (tag === "UL" || tag === "OL") return [list(element)];
  if (tag === "TABLE") return [table(element)].filter(Boolean);
  if (tag === "BLOCKQUOTE") {
    const quoted = renderBlocks(element).join("\n\n");
    return quoted ? [quoted.split("\n").map((line) => line ? `> ${line}` : ">").join("\n")] : [];
  }
  return renderBlocks(element);
}

function codeBlock(pre: Element): string {
  const code = pre.textContent?.replace(/\n$/, "") ?? "";
  const language = /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(`${pre.className} ${pre.querySelector("code")?.className ?? ""}`)?.[1] ?? "";
  let fence = "```";
  while (code.includes(fence)) fence += "`";
  return `${fence}${language}\n${code}\n${fence}`;
}

function list(element: Element): string {
  const ordered = element.tagName === "OL";
  let number = Number(element.getAttribute("start") ?? 1) || 1;
  const items: string[] = [];
  for (const item of element.children) {
    if (item.tagName !== "LI") continue;
    const box = item.querySelector(":scope > input[type=checkbox], :scope > p > input[type=checkbox]");
    box?.remove();
    const marker = `${ordered ? `${number++}.` : "-"} ${box ? `[${(box as HTMLInputElement).checked || box.hasAttribute("checked") ? "x" : " "}] ` : ""}`;
    const indent = " ".repeat(ordered ? marker.indexOf(" ") + 1 : 2);
    const content = renderBlocks(item).join("\n");
    items.push(marker + content.split("\n").map((line, index) => index && line ? indent + line : line).join("\n"));
  }
  return items.join("\n");
}

function table(element: Element): string {
  const rows = [...(element as HTMLTableElement).rows].map((row) => [...row.cells].map((cell) =>
    tidy(renderInline(cell)).replace(/\n+/g, " ").replace(/\|/g, "\\|")));
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (!width) return "";
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
  return [line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
}

function renderInline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText((node.textContent ?? "").replace(/\s+/g, " "));
  if (!(node instanceof Element)) return "";
  const inner = () => [...node.childNodes].map(renderInline).join("");
  switch (node.tagName) {
    case "BR": return "\n";
    case "STRONG": return wrap(inner(), "**");
    case "B": return notBold(node) ? inner() : wrap(inner(), "**");
    case "EM": case "I": return wrap(inner(), "*");
    case "DEL": case "S": case "STRIKE": return wrap(inner(), "~~");
    case "SPAN": return wrap(inner(), styleMark(node));
    case "CODE": return inlineCode(node.textContent ?? "");
    case "IMG": return image(node);
    case "A": return link(node, inner());
    default: return BLOCKS.has(node.tagName) ? `\n${renderBlocks(node).join("\n")}\n` : inner();
  }
}

/** Marks hug their text: whitespace inside the element moves outside them. */
function wrap(text: string, mark: string): string {
  if (!mark) return text;
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  return core ? `${lead}${mark}${core}${mark.split("").reverse().join("")}${trail}` : text;
}

function inlineCode(text: string): string {
  const code = text.replace(/\s+/g, " ");
  if (!code.trim()) return code;
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longest + 1);
  return longest ? `${ticks} ${code} ${ticks}` : `${ticks}${code}${ticks}`;
}

function destination(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, encodeURIComponent)}>` : url;
}

function image(element: Element): string {
  const source = element.getAttribute("src") ?? "";
  // Data URLs can be megabytes; only linkable images survive.
  if (!/^https?:\/\//i.test(source)) return "";
  const alt = (element.getAttribute("alt") ?? "").replace(/\s+/g, " ").replace(/[[\]\\]/g, "\\$&");
  return `![${alt}](${destination(source)})`;
}

function link(element: Element, text: string): string {
  const href = element.getAttribute("href") ?? "";
  const label = text.trim();
  if (!/^(?:https?:|mailto:)/i.test(href) || !label) return text;
  if (label === escapeText(href)) return href;
  const [, lead, , trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  return `${lead}[${label}](${destination(href)})${trail}`;
}

/** Characters that would turn plain text into Markdown syntax. Underscores inside words are literal. */
function escapeText(text: string): string {
  return text.replace(/[\\`*[\]]|(?<!\w)_|_(?!\w)|<(?=[a-z/!])/gi, "\\$&");
}

/** A paragraph that happens to start like a heading, list, quote or rule stays a paragraph. */
function escapeBlockStart(text: string): string {
  return text.replace(/^(\s*)(#{1,6}(?=\s)|[-+](?=\s)|>|(\d+)([.)])(?=\s))/gm, (_match, space: string, start: string, digits?: string, delimiter?: string) =>
    digits ? `${space}${digits}\\${delimiter}` : `${space}\\${start}`);
}

/** Whitespace a browser would not show: around line breaks, doubled, and at the ends. */
function tidy(text: string): string {
  return text.replace(/[ \t]*\n[ \t]*/g, "\n").replace(/ {2,}/g, " ").trim();
}
