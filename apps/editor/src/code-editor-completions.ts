import {
  autocompletion,
  startCompletion,
  type Completion,
  type CompletionContext
} from "@codemirror/autocomplete";
import { EditorSelection, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { linkMatches, resolveLinkSuggestion, wikilinkFor, type LinkSuggestion } from "./links";
import type { CollectionFile, NoteSummary } from "./model";

export function writerAutocomplete(
  suggestions: () => LinkSuggestion[],
  types: () => string[],
  currentPath: () => string | undefined,
  recentPaths: () => string[],
  files: () => CollectionFile[],
  notes: () => NoteSummary[]
): Extension {
  return autocompletion({
    activateOnTyping: true,
    interactionDelay: 0,
    override: [(context) => linkCompletion(
      context,
      suggestions(),
      types(),
      currentPath(),
      recentPaths(),
      files(),
      notes()
    ) ?? slashCompletion(context)]
  });
}

export function linkCompletion(
  context: CompletionContext,
  suggestions: LinkSuggestion[],
  types: string[],
  currentPath?: string,
  recentPaths: string[] = [],
  files: CollectionFile[] = [],
  notes: NoteSummary[] = []
) {
  const wikilink = context.matchBefore(/!?\[\[[^\]\n]*/);
  const mention = context.matchBefore(/(?:^|[\s([{])@[^@\n]*/);
  if (!wikilink && !mention) return null;
  if (wikilink && (!mention || wikilink.from > mention.from)) {
    const openerLength = wikilink.text.startsWith("![[") ? 3 : 2;
    const query = wikilink.text.slice(openerLength);
    const heading = headingCompletions(
      wikilink.from + openerLength,
      context.pos,
      query,
      suggestions,
      notes,
      currentPath,
      context.state.doc.toString()
    );
    return heading ?? objectCompletions(
      wikilink.from + openerLength,
      context.pos,
      suggestions,
      files,
      query,
      currentPath,
      recentPaths,
      wikilink.text.startsWith("![[")
    );
  }

  const at = mention!.text.lastIndexOf("@");
  const from = mention!.from + at;
  const scope = mentionScope(mention!.text.slice(at + 1), types);
  const options: Completion[] = [];
  if (scope.showTypes) {
    const typeQuery = scope.typeQuery.toLocaleLowerCase();
    for (const type of types.filter((candidate) => candidate.toLocaleLowerCase().includes(typeQuery))) {
      options.push({
        label: `/${type}`,
        detail: "Filter links by type",
        type: "type",
        apply: (view, _completion, applyFrom, applyTo) => {
          const insert = `@/${type}/`;
          view.dispatch({ changes: { from: applyFrom, to: applyTo, insert }, selection: { anchor: applyFrom + insert.length } });
          queueMicrotask(() => startCompletion(view));
        }
      });
    }
  }
  if (!scope.typeQuery || scope.type) {
    options.push(...objectOptions(suggestions, scope.query, scope.type, true, currentPath, recentPaths));
  }
  return { from, to: context.pos, options, filter: false };
}

function objectCompletions(
  from: number,
  to: number,
  suggestions: LinkSuggestion[],
  files: CollectionFile[],
  query: string,
  currentPath?: string,
  recentPaths: string[] = [],
  embed = false
) {
  return {
    from,
    to,
    options: [
      ...objectOptions(suggestions, query, undefined, false, currentPath, recentPaths, embed),
      ...fileOptions(files, query, embed)
    ],
    filter: false
  };
}

function objectOptions(
  suggestions: LinkSuggestion[],
  query: string,
  type?: string,
  mention = false,
  currentPath?: string,
  recentPaths: string[] = [],
  embed = false
): Completion[] {
  return linkMatches(suggestions, query, type, 50, { currentPath, recentPaths }).map(({ suggestion, label }) => ({
    label,
    detail: `${embed ? "Transclude note · " : ""}${suggestionDetail(suggestion, label)}`,
    type: "text",
    apply: mention ? `[[${wikilinkFor(suggestion, label)}]]` : `${wikilinkFor(suggestion, label)}]]`
  }));
}

function fileOptions(files: CollectionFile[], query: string, embed: boolean): Completion[] {
  const needle = query.trim().toLocaleLowerCase();
  return files
    .filter((file) => {
      const path = file.path.toLocaleLowerCase();
      const filename = path.split("/").at(-1) ?? path;
      return !needle || path.includes(needle) || filename.includes(needle);
    })
    .sort((left, right) => left.path.length - right.path.length || left.path.localeCompare(right.path))
    .slice(0, 30)
    .map((file) => ({
      label: file.path.split("/").at(-1) ?? file.path,
      detail: `${embed ? "Transclude file" : "File"} · ${file.path}`,
      type: "text",
      apply: `${file.path}]]`
    }));
}

function headingCompletions(
  from: number,
  to: number,
  query: string,
  suggestions: LinkSuggestion[],
  notes: NoteSummary[],
  currentPath: string | undefined,
  currentBody: string
) {
  const hash = query.indexOf("#");
  if (hash < 0) return undefined;
  const target = query.slice(0, hash).trim();
  const fragmentQuery = query.slice(hash + 1).toLocaleLowerCase();
  const suggestion = target
    ? resolveLinkSuggestion(target, suggestions, currentPath)
    : suggestions.find((candidate) => candidate.path === currentPath);
  const body = suggestion
    ? notes.find((note) => note.path === suggestion.path)?.body
    : currentBody;
  if (body === undefined) return { from: from + hash + 1, to, options: [], filter: false };
  const options = markdownAnchors(body)
    .filter((anchor) => !fragmentQuery || anchor.label.toLocaleLowerCase().includes(fragmentQuery))
    .map((anchor) => ({
      label: anchor.label,
      detail: anchor.kind === "heading" ? "Section in note" : `Block · ${anchor.preview}`,
      type: "text",
      apply: `${anchor.value}]]`
    }));
  return { from: from + hash + 1, to, options, filter: false };
}

function markdownAnchors(body: string): Array<{ label: string; value: string; kind: "heading" | "block"; preview?: string }> {
  const withoutFences = body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "");
  const headings = [...withoutFences.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((match) => ({
    label: match[1].trim(),
    value: match[1].trim(),
    kind: "heading" as const
  }));
  const blocks = [...withoutFences.matchAll(/^(.+?)\s+\^([\p{L}\p{N}_-]+)\s*$/gmu)].map((match) => ({
    label: `^${match[2]}`,
    value: `^${match[2]}`,
    kind: "block" as const,
    preview: match[1].trim().slice(0, 72)
  }));
  return [...headings, ...blocks];
}

function suggestionDetail(suggestion: LinkSuggestion, label: string): string {
  const parts: string[] = [];
  if (label !== suggestion.title) parts.push(suggestion.title);
  if (suggestion.types?.length) parts.push(suggestion.types.join(", "));
  parts.push(suggestion.path);
  return parts.join(" · ");
}

export function mentionScope(raw: string, types: string[]): {
  query: string;
  type?: string;
  typeQuery: string;
  showTypes: boolean;
} {
  if (!raw.startsWith("/")) return { query: raw.trim(), typeQuery: "", showTypes: !raw.trim() };
  const scoped = raw.slice(1);
  const separator = scoped.indexOf("/");
  if (separator < 0) return { query: "", typeQuery: scoped.trim(), showTypes: true };
  const requestedType = scoped.slice(0, separator).trim();
  const type = types.find((candidate) => candidate.localeCompare(requestedType, undefined, { sensitivity: "accent" }) === 0);
  return {
    query: scoped.slice(separator + 1).trim(),
    type,
    typeQuery: type ? "" : requestedType,
    showTypes: !type
  };
}

function slashCompletion(context: CompletionContext) {
  const command = context.matchBefore(/[^\S\n]*\/[^\n]*/);
  if (!command || command.from !== context.state.doc.lineAt(context.pos).from) return null;
  const query = command.text.slice(command.text.indexOf("/") + 1).trim().toLocaleLowerCase();
  const options = slashCommands
    .filter((item) => !query || item.label.toLocaleLowerCase().includes(query) || item.keywords.some((keyword) => keyword.includes(query)))
    .map((item) => ({
      label: item.label,
      detail: item.detail,
      type: "keyword",
      apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
        const indentation = command.text.slice(0, command.text.indexOf("/"));
        const insert = `${indentation}${item.insert}`;
        const cursor = from + indentation.length + item.cursor;
        view.dispatch({
          changes: { from, to, insert },
          selection: EditorSelection.cursor(cursor),
          scrollIntoView: true
        });
        if (item.complete) queueMicrotask(() => startCompletion(view));
      }
    }));
  return { from: command.from, to: context.pos, options, filter: false };
}

const slashCommands: Array<{
  label: string;
  detail: string;
  insert: string;
  cursor: number;
  keywords: string[];
  complete?: boolean;
}> = [
  { label: "Heading 1", detail: "Large section heading", insert: "# ", cursor: 2, keywords: ["title", "h1"] },
  { label: "Heading 2", detail: "Section heading", insert: "## ", cursor: 3, keywords: ["subtitle", "h2"] },
  { label: "Heading 3", detail: "Small section heading", insert: "### ", cursor: 4, keywords: ["h3"] },
  { label: "Bulleted list", detail: "Start a list", insert: "- ", cursor: 2, keywords: ["bullet", "unordered"] },
  { label: "Numbered list", detail: "Start an ordered list", insert: "1. ", cursor: 3, keywords: ["ordered", "number"] },
  { label: "Task", detail: "Start a checkable task", insert: "- [ ] ", cursor: 6, keywords: ["todo", "checkbox"] },
  { label: "Quote", detail: "Set off quoted text", insert: "> ", cursor: 2, keywords: ["blockquote"] },
  { label: "Code block", detail: "Insert a fenced code block", insert: "```\n\n```", cursor: 4, keywords: ["fence", "preformatted"] },
  { label: "Divider", detail: "Separate sections", insert: "---", cursor: 3, keywords: ["rule", "separator"], complete: false },
  { label: "Link to note or file", detail: "Insert an internal link", insert: "[[", cursor: 2, keywords: ["wikilink", "reference"], complete: true },
  { label: "Transclude note or file", detail: "Embed collection content", insert: "![[", cursor: 3, keywords: ["embed", "reference"], complete: true },
  { label: "Table", detail: "Insert a Markdown table", insert: "| Column | Column |\n| --- | --- |\n| Value | Value |", cursor: 2, keywords: ["grid", "columns"], complete: false }
];
