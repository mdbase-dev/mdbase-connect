import { markdownLanguage } from "@codemirror/lang-markdown";
import { NodeType, Tree, TreeBuffer, TreeFragment } from "@lezer/common";
import { changedSpan } from "./changed-span";

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

interface Parse { source: string; tree: Tree; references?: readonly MarkdownReference[] }

/** The latest parses: panes and hooks reading one note's text share its tree and references. */
const parses: Parse[] = [];

/**
 * Parses `source`, reusing the tree of the text it was edited from. An edit
 * reparses only around the changed span, so typing in a long note does not
 * parse the whole note again.
 */
function parseMarkdown(source: string): Parse {
  const index = parses.findIndex((parse) => parse.source === source);
  const parse = index >= 0 ? parses.splice(index, 1)[0]! : { source, tree: reparse(source, parses[0]) };
  parses.unshift(parse);
  parses.length = Math.min(parses.length, 4);
  return parse;
}

function reparse(source: string, previous: { source: string; tree: Tree } | undefined): Tree {
  if (!previous) return markdownLanguage.parser.parse(source);
  const { from, to, insert } = changedSpan(previous.source, source);
  const fragments = TreeFragment.applyChanges(TreeFragment.addTree(previous.tree), [{ fromA: from, toA: to, fromB: from, toB: from + insert.length }]);
  return markdownLanguage.parser.parse(source, fragments);
}

/**
 * Extracts portable Markdown and wiki references from the Markdown syntax tree.
 * Code spans and fenced code are ignored because they never produce Link/Image
 * nodes. Wiki embeds are parsed as Image nodes by the common Markdown grammar.
 */
export function markdownReferences(source: string, tree?: Tree): readonly MarkdownReference[] {
  if (tree) return collectReferences(source, tree);
  // Each keystroke would otherwise walk the whole note once per reader.
  const parse = parseMarkdown(source);
  return parse.references ??= collectReferences(source, parse.tree);
}

function collectReferences(source: string, tree: Tree): MarkdownReference[] {
  return subtreeReferences(source, tree, 0).map((reference) => ({
    ...reference,
    block: isBlockReference(source, reference.from, reference.to)
  }));
}

type FoundReference = Omit<MarkdownReference, "block">;

/**
 * References found in each subtree, with positions relative to its start. An
 * incremental parse reuses the subtrees of unchanged blocks, so after an edit
 * only the path to the edited block is walked again. A reused subtree covers
 * the same text, so what it holds cannot have changed; whether a reference
 * stands alone on its line depends on the text around it, and is decided again
 * for every call.
 */
const foundInSubtree = new WeakMap<Tree | TreeBuffer, readonly FoundReference[]>();

function subtreeReferences(source: string, tree: Tree | TreeBuffer, offset: number): readonly FoundReference[] {
  const cached = foundInSubtree.get(tree);
  if (cached) return cached;
  const found: FoundReference[] = [];
  if (tree instanceof Tree && !referenceNode(tree.type.name)) {
    tree.children.forEach((child, index) => {
      const at = tree.positions[index]!;
      for (const reference of subtreeReferences(source, child, offset + at)) {
        found.push({ ...reference, from: reference.from + at, to: reference.to + at });
      }
    });
  } else {
    walk(source, new Tree(NodeType.none, [tree], [0], tree.length), offset, found);
  }
  foundInSubtree.set(tree, found);
  return found;
}

function referenceNode(name: string): MarkdownReferenceKind | undefined {
  return name === "Image" ? "embed" : name === "Link" ? "link" : undefined;
}

/** Collects references in `tree`, which starts at `offset` in `source`, relative to that start. */
function walk(source: string, tree: Tree, offset: number, found: FoundReference[]) {
  const cursor = tree.cursor();
  const visit = () => {
    const kind = referenceNode(cursor.name);
    if (kind) {
      const nodeFrom = offset + cursor.from, nodeTo = offset + cursor.to;
      // CodeMirror represents [[wikilinks]] as a Link containing only the inner
      // [target] range. Recover the outer bracket pair while retaining the syntax
      // tree's exclusion of code spans and fenced code.
      const wrappedWikiLink = kind === "link"
        && !cursor.node.getChild("URL")
        && nodeFrom > 0
        && source[nodeFrom - 1] === "["
        && source[nodeTo] === "]";
      const from = wrappedWikiLink ? nodeFrom - 1 : nodeFrom;
      const to = wrappedWikiLink ? nodeTo + 1 : nodeTo;
      const raw = source.slice(from, to);
      const parsed = raw.startsWith(kind === "embed" ? "![[" : "[[")
        ? parseWikiReference(raw, kind)
        : parseMarkdownReference(source, cursor.node, offset, kind);
      if (parsed) found.push({ from: from - offset, to: to - offset, ...parsed });
      // Image nodes contain a nested Link node in the CommonMark tree.
      if (kind === "embed") return;
    }
    if (cursor.firstChild()) {
      do visit(); while (cursor.nextSibling());
      cursor.parent();
    }
  };
  visit();
}

export function markdownReferenceAt(
  source: string,
  position: number,
  kind?: MarkdownReferenceKind,
  tree?: Tree
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
  node: ReturnType<Tree["resolve"]>,
  offset: number,
  kind: MarkdownReferenceKind
): Pick<MarkdownReference, "target" | "label" | "anchor" | "kind" | "format"> | undefined {
  const url = node.getChild("URL");
  if (!url) return undefined;
  const rawTarget = source.slice(offset + url.from, offset + url.to).replace(/^<|>$/g, "").trim();
  if (!rawTarget) return undefined;
  const hash = rawTarget.indexOf("#");
  const target = (hash < 0 ? rawTarget : rawTarget.slice(0, hash)).trim();
  const anchor = hash < 0 ? undefined : rawTarget.slice(hash + 1).trim() || undefined;
  if (!target && !anchor) return undefined;

  const prefix = source.slice(offset + node.from, offset + url.from);
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
