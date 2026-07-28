import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  startCompletion,
  type Completion,
  type CompletionContext
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyField, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  bracketMatching,
  defaultHighlightStyle,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
  syntaxTree
} from "@codemirror/language";
import { lintGutter, linter, lintKeymap, type Diagnostic } from "@codemirror/lint";
import { closeSearchPanel, highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, Prec, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder as editorPlaceholder,
  scrollPastEnd,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { parseDocument as parseYamlDocument } from "yaml";
import { linkMatches, wikilinkFor, type LinkSuggestion } from "./links";
import type { NotePreviewAnchor, NotePreviewSource } from "./NotePreview";

type EditorLanguage = "markdown" | "json" | "yaml" | "yaml-frontmatter" | "plain";
type EditorVariant = "writer" | "source";
export type MarkdownFormat = "bold" | "italic" | "code" | "link";

interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  label: string;
  language?: EditorLanguage;
  variant?: EditorVariant;
  placeholder?: string;
  readOnly?: boolean;
  vimEnabled?: boolean;
  lineWrapping?: boolean;
  autoFocus?: boolean;
  quietMarkdown?: boolean;
  className?: string;
  documentId?: string;
  currentPath?: string;
  recentPaths?: string[];
  linkSuggestions?: LinkSuggestion[];
  linkTypes?: string[];
  onOpenLink?: (path: string) => void;
  onCreateLink?: (target: string, label: string | undefined, format: "wikilink" | "markdown") => void;
  onPreviewLink?: (path: string, anchor: NotePreviewAnchor, source: NotePreviewSource) => void;
  onDismissLinkPreview?: () => void;
  onBlur?: () => void;
}

interface RememberedEditor {
  state: unknown;
  scrollTop: number;
  separator: "\n" | "\r\n";
}

interface MarkdownEdit {
  from: number;
  to: number;
  insert: string;
  anchor: number;
  head: number;
}

const rememberedEditors = new Map<string, RememberedEditor>();
const rememberedEditorLimit = 40;

export function CodeEditor({
  value,
  onChange,
  label,
  language = "plain",
  variant = "source",
  placeholder,
  readOnly = false,
  vimEnabled = false,
  lineWrapping = true,
  autoFocus = false,
  quietMarkdown = true,
  className = "",
  documentId,
  currentPath,
  recentPaths = [],
  linkSuggestions = [],
  linkTypes = [],
  onOpenLink,
  onCreateLink,
  onPreviewLink,
  onDismissLinkPreview,
  onBlur
}: CodeEditorProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  const syncing = useRef(false);
  const vimMode = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  const completions = useRef(new Compartment());
  const languageMode = useRef(new Compartment());
  const writerPresentation = useRef(new Compartment());
  const linkSuggestionsRef = useRef(linkSuggestions);
  const linkTypesRef = useRef(linkTypes);
  const recentPathsRef = useRef(recentPaths);
  const currentPathRef = useRef(currentPath);
  const onOpenLinkRef = useRef(onOpenLink);
  const onCreateLinkRef = useRef(onCreateLink);
  const onPreviewLinkRef = useRef(onPreviewLink);
  const onDismissLinkPreviewRef = useRef(onDismissLinkPreview);
  const lineSeparator = useRef(lineSeparatorFor(value));

  linkSuggestionsRef.current = linkSuggestions;
  linkTypesRef.current = linkTypes;
  recentPathsRef.current = recentPaths;
  currentPathRef.current = currentPath;
  onOpenLinkRef.current = onOpenLink;
  onCreateLinkRef.current = onCreateLink;
  onPreviewLinkRef.current = onPreviewLink;
  onDismissLinkPreviewRef.current = onDismissLinkPreview;

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  useEffect(() => {
    if (!parentRef.current) return;
    const extensions: Extension[] = [
      vimMode.current.of([]),
      editorSetup(variant),
      syntaxHighlighting(mdbaseHighlightStyle),
      variant === "writer" ? syntaxHighlighting(writerHighlightStyle) : [],
      languageMode.current.of(language === "markdown" ? markdown() : []),
      wrapping.current.of(lineWrapping ? EditorView.lineWrapping : []),
      completions.current.of(variant === "writer" && language === "markdown" ? writerAutocomplete(
        () => linkSuggestionsRef.current,
        () => linkTypesRef.current,
        () => currentPathRef.current,
        () => recentPathsRef.current
      ) : []),
      writerPresentation.current.of(variant === "writer" && quietMarkdown ? quietMarkdownPresentation : []),
      variant === "writer" ? writerInteractions(
        () => linkSuggestionsRef.current,
        () => currentPathRef.current,
        () => onOpenLinkRef.current,
        () => onCreateLinkRef.current,
        () => onPreviewLinkRef.current,
        () => onDismissLinkPreviewRef.current
      ) : [],
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      EditorView.contentAttributes.of({
        "aria-label": label,
        "aria-multiline": "true",
        tabindex: "0",
        spellcheck: variant === "writer" && language === "markdown" ? "true" : "false"
      }),
      placeholder ? editorPlaceholder(placeholder) : [],
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !syncing.current) {
          onChangeRef.current?.(restoreLineSeparators(update.state.doc.toString(), lineSeparator.current));
        }
      })
    ];
    const remembered = documentId ? rememberedEditors.get(documentId) : undefined;
    const config = { extensions };
    const state = remembered && rememberedValue(remembered) === value
      ? EditorState.fromJSON(remembered.state, config, { history: historyField })
      : EditorState.create({ doc: value, extensions });
    const view = new EditorView({ parent: parentRef.current, state });
    viewRef.current = view;
    requestAnimationFrame(() => {
      if (viewRef.current !== view) return;
      if (remembered) view.scrollDOM.scrollTop = remembered.scrollTop;
      if (autoFocus) view.focus();
    });
    return () => {
      if (documentId) rememberEditor(documentId, view, lineSeparator.current);
      onDismissLinkPreviewRef.current?.();
      view.destroy();
      viewRef.current = undefined;
    };
    // The editor is recreated when its document identity changes via React's key.
    // Runtime preferences are reconfigured by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (!vimEnabled || readOnly) {
      view.dispatch({ effects: vimMode.current.reconfigure([]) });
      return;
    }
    let cancelled = false;
    void import("@replit/codemirror-vim").then(({ Vim, getCM, vim }) => {
      if (!cancelled && viewRef.current === view) {
        const exitVimFromSearch = Prec.highest(keymap.of([{
          key: "Escape",
          scope: "search-panel",
          run: (activeView) => {
            if (!closeSearchPanel(activeView)) return false;
            const cm = getCM(activeView);
            if (cm) Vim.handleKey(cm, "<Esc>", "user");
            activeView.focus();
            return true;
          }
        }]));
        view.dispatch({ effects: vimMode.current.reconfigure([vim(), exitVimFromSearch]) });
      }
    });
    return () => { cancelled = true; };
  }, [readOnly, vimEnabled]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: wrapping.current.reconfigure(lineWrapping ? EditorView.lineWrapping : []) });
  }, [lineWrapping]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: completions.current.reconfigure(variant === "writer" && language === "markdown" ? writerAutocomplete(
        () => linkSuggestionsRef.current,
        () => linkTypesRef.current,
        () => currentPathRef.current,
        () => recentPathsRef.current
      ) : [])
    });
  }, [language, variant]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: writerPresentation.current.reconfigure(
        variant === "writer" && quietMarkdown ? quietMarkdownPresentation : []
      )
    });
  }, [quietMarkdown, variant]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (language === "markdown") {
      view.dispatch({ effects: languageMode.current.reconfigure(markdown()) });
      return;
    }
    if (language === "plain") {
      view.dispatch({ effects: languageMode.current.reconfigure([]) });
      return;
    }
    let cancelled = false;
    const load = language === "json"
      ? import("@codemirror/lang-json").then(({ json, jsonParseLinter }) => [
        json(),
        variant === "source" ? linter(jsonParseLinter()) : []
      ] as Extension)
      : import("@codemirror/lang-yaml").then(({ yaml }) => [
        yaml(),
        variant === "source" ? linter(language === "yaml-frontmatter" ? yamlFrontmatterLinter : yamlLinter) : []
      ] as Extension);
    void load.then((extension) => {
      if (!cancelled && viewRef.current === view) {
        view.dispatch({ effects: languageMode.current.reconfigure(extension) });
      }
    });
    return () => { cancelled = true; };
  }, [language, variant]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || restoreLineSeparators(view.state.doc.toString(), lineSeparator.current) === value) return;
    syncing.current = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: EditorSelection.cursor(Math.min(view.state.selection.main.head, value.length))
    });
    syncing.current = false;
  }, [value]);

  return <div
    ref={parentRef}
    className={`code-editor code-editor-${variant} ${className}`.trim()}
    onBlur={(event) => {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      onBlur?.();
    }}
  />;
}

export function lineSeparatorFor(value: string): "\n" | "\r\n" {
  return value.includes("\r\n") ? "\r\n" : "\n";
}

export function restoreLineSeparators(value: string, separator: "\n" | "\r\n"): string {
  const normalized = value.replace(/\r\n/g, "\n");
  return separator === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized;
}

export function markdownEdit(doc: string, from: number, to: number, format: MarkdownFormat): MarkdownEdit {
  const selected = doc.slice(from, to);
  if (format === "link") {
    const label = selected || "link";
    const insert = `[${label}](https://)`;
    return selected
      ? { from, to, insert, anchor: from + label.length + 3, head: from + label.length + 11 }
      : { from, to, insert, anchor: from + 1, head: from + 1 + label.length };
  }

  const [before, after, fallback] = format === "bold"
    ? ["**", "**", "bold"]
    : format === "italic"
      ? ["*", "*", "italic"]
      : ["`", "`", "code"];
  if (selected && doc.slice(from - before.length, from) === before && doc.slice(to, to + after.length) === after) {
    return {
      from: from - before.length,
      to: to + after.length,
      insert: selected,
      anchor: from - before.length,
      head: to - before.length
    };
  }
  const content = selected || fallback;
  return {
    from,
    to,
    insert: `${before}${content}${after}`,
    anchor: from + before.length,
    head: from + before.length + content.length
  };
}

const editorSetup = (variant: EditorVariant): Extension => [
  highlightSpecialChars(),
  history(),
  search({ top: true }),
  highlightSelectionMatches({ minSelectionLength: 2 }),
  bracketMatching(),
  variant === "writer" ? scrollPastEnd() : [
    lineNumbers(),
    indentOnInput(),
    closeBrackets(),
    lintGutter()
  ],
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  keymap.of([
    ...(variant === "writer" ? writerKeymap : []),
    ...(variant === "source" ? closeBracketsKeymap : []),
    ...searchKeymap,
    ...defaultKeymap,
    ...historyKeymap,
    ...(variant === "source" ? lintKeymap : [])
  ])
];

const writerKeymap = [
  { key: "Mod-b", run: markdownFormatCommand("bold") },
  { key: "Mod-i", run: markdownFormatCommand("italic") },
  { key: "Mod-k", run: markdownFormatCommand("link") },
  { key: "Mod-Shift-c", run: markdownFormatCommand("code") }
];

const mdbaseHighlightStyle = HighlightStyle.define([
  { tag: [tags.comment, tags.meta], color: "var(--syntax-comment)" },
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.typeName, tags.bool, tags.null], color: "var(--syntax-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.escape], color: "var(--syntax-string)" },
  { tag: [tags.number, tags.atom, tags.annotation, tags.namespace], color: "var(--syntax-number)" },
  { tag: [tags.link, tags.url], color: "var(--syntax-link)", textDecoration: "underline" },
  { tag: [tags.heading, tags.strong], color: "var(--syntax-heading)", fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.quote, color: "var(--muted)" },
  { tag: tags.monospace, fontFamily: "var(--mono)", fontSize: "0.9em" },
  { tag: tags.invalid, color: "var(--danger)" }
]);

const writerHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.42em" },
  { tag: tags.heading2, fontSize: "1.24em" },
  { tag: tags.heading3, fontSize: "1.1em" }
]);

function markdownFormatCommand(format: MarkdownFormat) {
  return (view: EditorView) => {
    const transaction = view.state.changeByRange((range) => {
      const edit = markdownEdit(view.state.doc.toString(), range.from, range.to, format);
      return {
        changes: { from: edit.from, to: edit.to, insert: edit.insert },
        range: EditorSelection.range(edit.anchor, edit.head)
      };
    });
    view.dispatch({
      ...transaction,
      scrollIntoView: true,
      userEvent: "input"
    });
    return true;
  };
}

function writerAutocomplete(
  suggestions: () => LinkSuggestion[],
  types: () => string[],
  currentPath: () => string | undefined,
  recentPaths: () => string[]
): Extension {
  return autocompletion({
    activateOnTyping: true,
    interactionDelay: 0,
    override: [(context) => linkCompletion(
      context,
      suggestions(),
      types(),
      currentPath(),
      recentPaths()
    ) ?? slashCompletion(context)]
  });
}

export function linkCompletion(
  context: CompletionContext,
  suggestions: LinkSuggestion[],
  types: string[],
  currentPath?: string,
  recentPaths: string[] = []
) {
  const wikilink = context.matchBefore(/\[\[[^\]\n]*/);
  const mention = context.matchBefore(/(?:^|[\s([{])@[^@\n]*/);
  if (!wikilink && !mention) return null;
  if (wikilink && (!mention || wikilink.from > mention.from)) {
    const query = wikilink.text.slice(2);
    return objectCompletions(wikilink.from + 2, context.pos, suggestions, query, currentPath, recentPaths);
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
  query: string,
  currentPath?: string,
  recentPaths: string[] = []
) {
  return {
    from,
    to,
    options: objectOptions(suggestions, query, undefined, false, currentPath, recentPaths),
    filter: false
  };
}

function objectOptions(
  suggestions: LinkSuggestion[],
  query: string,
  type?: string,
  mention = false,
  currentPath?: string,
  recentPaths: string[] = []
): Completion[] {
  return linkMatches(suggestions, query, type, 50, { currentPath, recentPaths }).map(({ suggestion, label }) => ({
    label,
    detail: suggestionDetail(suggestion, label),
    type: "text",
    apply: mention ? `[[${wikilinkFor(suggestion, label)}]]` : `${wikilinkFor(suggestion, label)}]]`
  }));
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
      }
    }));
  return { from: command.from, to: context.pos, options, filter: false };
}

const slashCommands = [
  { label: "Heading 1", detail: "Large section heading", insert: "# ", cursor: 2, keywords: ["title", "h1"] },
  { label: "Heading 2", detail: "Section heading", insert: "## ", cursor: 3, keywords: ["subtitle", "h2"] },
  { label: "Heading 3", detail: "Small section heading", insert: "### ", cursor: 4, keywords: ["h3"] },
  { label: "Bulleted list", detail: "Start a list", insert: "- ", cursor: 2, keywords: ["bullet", "unordered"] },
  { label: "Numbered list", detail: "Start an ordered list", insert: "1. ", cursor: 3, keywords: ["ordered", "number"] },
  { label: "Task", detail: "Start a checkable task", insert: "- [ ] ", cursor: 6, keywords: ["todo", "checkbox"] },
  { label: "Quote", detail: "Set off quoted text", insert: "> ", cursor: 2, keywords: ["blockquote"] },
  { label: "Code block", detail: "Insert a fenced code block", insert: "```\n\n```", cursor: 4, keywords: ["fence", "preformatted"] },
  { label: "Divider", detail: "Separate sections", insert: "---", cursor: 3, keywords: ["rule", "separator"] }
];

const quietMarkdownPresentation = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = markdownDecorations(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      this.decorations = markdownDecorations(update.view);
    }
  }
}, {
  decorations: (value) => value.decorations
});

class TaskCheckboxWidget extends WidgetType {
  constructor(readonly from: number, readonly checked: boolean) {
    super();
  }

  eq(other: TaskCheckboxWidget) {
    return this.from === other.from && this.checked === other.checked;
  }

  toDOM() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-task-checkbox";
    button.dataset.taskFrom = String(this.from);
    button.setAttribute("role", "checkbox");
    button.setAttribute("aria-checked", String(this.checked));
    button.setAttribute("aria-label", this.checked ? "Mark task incomplete" : "Mark task complete");
    button.title = this.checked ? "Mark task incomplete" : "Mark task complete";
    button.textContent = this.checked ? "✓" : "";
    return button;
  }

  ignoreEvent() {
    return false;
  }
}

function markdownDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const activeLines = new Set(view.state.selection.ranges.map((range) => view.state.doc.lineAt(range.head).from));
  const visibleLines = new Set<number>();
  for (const visible of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        if (!markdownMarkerNames.has(node.name) || activeLines.has(view.state.doc.lineAt(node.from).from)) return;
        ranges.push(Decoration.mark({ class: "cm-markdown-mark" }).range(node.from, node.to));
      }
    });
    let line = view.state.doc.lineAt(visible.from);
    while (line.from <= visible.to) {
      if (!visibleLines.has(line.from)) {
        visibleLines.add(line.from);
        const task = /^(\s*(?:[-+*]|\d+[.)])\s+)\[([ xX])\](?=\s|$)/.exec(line.text);
        if (task && !activeLines.has(line.from)) {
          const from = line.from + task[1].length;
          ranges.push(Decoration.replace({
            widget: new TaskCheckboxWidget(from, task[2].toLocaleLowerCase() === "x")
          }).range(from, from + 3));
        }
      }
      if (line.to >= view.state.doc.length || line.to >= visible.to) break;
      line = view.state.doc.line(line.number + 1);
    }
  }
  return Decoration.set(ranges, true);
}

const markdownMarkerNames = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "QuoteMark",
  "ListMark",
  "LinkMark"
]);

function writerInteractions(
  suggestions: () => LinkSuggestion[],
  currentPath: () => string | undefined,
  onOpenLink: () => ((path: string) => void) | undefined,
  onCreateLink: () => ((target: string, label: string | undefined, format: "wikilink" | "markdown") => void) | undefined,
  onPreviewLink: () => ((path: string, anchor: NotePreviewAnchor, source: NotePreviewSource) => void) | undefined,
  onDismissLinkPreview: () => (() => void) | undefined
): Extension {
  let hoveredPath: string | undefined;
  const dismissPreview = (view: EditorView) => {
    if (!hoveredPath) return;
    hoveredPath = undefined;
    view.dom.classList.remove("cm-hovering-link");
    onDismissLinkPreview()?.();
  };
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const task = taskTarget(event);
      if (!task || event.button !== 0) return false;
      return toggleTask(view, task, event);
    },
    keydown(event, view) {
      const task = taskTarget(event);
      if (!task || (event.key !== "Enter" && event.key !== " ")) return false;
      return toggleTask(view, task, event);
    },
    click(event, view) {
      if (!event.metaKey && !event.ctrlKey) return false;
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (position === null) return false;
      const link = markdownLinkAt(view.state.doc.toString(), position);
      if (!link) return false;
      if (/^https?:\/\//i.test(link.target)) {
        event.preventDefault();
        window.open(link.target, "_blank", "noopener,noreferrer");
        return true;
      }
      if (!link.target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link.target)) return false;
      const path = resolveSuggestionPath(link.target, suggestions(), currentPath());
      const openLink = onOpenLink();
      const createLink = onCreateLink();
      if (!path && !createLink) return false;
      if (path && !openLink) return false;
      event.preventDefault();
      dismissPreview(view);
      if (path) openLink?.(path);
      else createLink?.(link.target, link.label, link.format);
      return true;
    },
    mousemove(event, view) {
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const path = position === null
        ? undefined
        : internalLinkPathAt(view.state.doc.toString(), position, suggestions(), currentPath());
      if (!path) {
        dismissPreview(view);
        return false;
      }
      if (hoveredPath === path) return false;
      if (hoveredPath) onDismissLinkPreview()?.();
      hoveredPath = path;
      view.dom.classList.add("cm-hovering-link");
      const coordinates = view.coordsAtPos(position ?? 0);
      const anchor: NotePreviewAnchor = {
        left: event.clientX,
        right: event.clientX,
        top: coordinates?.top ?? event.clientY,
        bottom: coordinates?.bottom ?? event.clientY
      };
      onPreviewLink()?.(path, anchor, "editor");
      return false;
    },
    mouseleave(_event, view) {
      dismissPreview(view);
      return false;
    }
  });
}

function taskTarget(event: Event): HTMLElement | null {
  return event.target instanceof Element ? event.target.closest<HTMLElement>(".cm-task-checkbox") : null;
}

function toggleTask(view: EditorView, target: HTMLElement, event: Event): boolean {
  const from = Number(target.dataset.taskFrom);
  if (!Number.isFinite(from)) return false;
  const source = view.state.sliceDoc(from, from + 3);
  if (!/^\[[ xX]\]$/.test(source)) return false;
  event.preventDefault();
  view.dispatch({
    changes: { from: from + 1, to: from + 2, insert: source[1].toLocaleLowerCase() === "x" ? " " : "x" },
    scrollIntoView: true,
    userEvent: "input"
  });
  view.focus();
  return true;
}

interface MarkdownLinkTarget {
  target: string;
  label?: string;
  format: "wikilink" | "markdown";
}

function markdownLinkAt(doc: string, position: number): MarkdownLinkTarget | undefined {
  const lineStart = doc.lastIndexOf("\n", position - 1) + 1;
  const lineEnd = doc.indexOf("\n", position);
  const end = lineEnd < 0 ? doc.length : lineEnd;
  const line = doc.slice(lineStart, end);
  for (const match of line.matchAll(/\[\[([^\]]+)\]\]|\[([^\]]*)\]\(([^)]+)\)/g)) {
    const from = lineStart + match.index;
    const to = from + match[0].length;
    if (position < from || position > to || doc[from - 1] === "!") continue;
    if (match[1] !== undefined) {
      const [target, label] = match[1].split("|", 2);
      return {
        target: target.split("#", 1)[0].trim(),
        label: label?.trim() || undefined,
        format: "wikilink"
      };
    }
    return {
      target: (match[3] ?? "").replace(/^<|>$/g, "").split("#", 1)[0].trim(),
      label: match[2]?.trim() || undefined,
      format: "markdown"
    };
  }
  return undefined;
}

export function internalLinkPathAt(
  doc: string,
  position: number,
  suggestions: LinkSuggestion[],
  sourcePath?: string
): string | undefined {
  const link = markdownLinkAt(doc, position);
  if (!link || /^https?:\/\//i.test(link.target)) return undefined;
  return resolveSuggestionPath(link.target, suggestions, sourcePath);
}

function resolveSuggestionPath(target: string, suggestions: LinkSuggestion[], sourcePath?: string): string | undefined {
  const normalized = target.replaceAll("\\", "/").replace(/^\.?\//, "").replace(/\.md$/i, "").toLocaleLowerCase();
  const exact = suggestions.find((suggestion) => suggestion.path.replace(/\.md$/i, "").toLocaleLowerCase() === normalized);
  if (exact) return exact.path;
  const sourceFolder = sourcePath?.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
  const candidates = suggestions.filter((suggestion) => {
    const filename = suggestion.path.split("/").at(-1)?.replace(/\.md$/i, "").toLocaleLowerCase();
    return filename === normalized
      || suggestion.title.toLocaleLowerCase() === normalized
      || suggestion.aliases?.some((alias) => alias.toLocaleLowerCase() === normalized);
  });
  return candidates.sort((left, right) => {
    const leftFolder = left.path.slice(0, Math.max(0, left.path.lastIndexOf("/")));
    const rightFolder = right.path.slice(0, Math.max(0, right.path.lastIndexOf("/")));
    return Number(rightFolder === sourceFolder) - Number(leftFolder === sourceFolder)
      || left.path.length - right.path.length
      || left.path.localeCompare(right.path);
  })[0]?.path;
}

function yamlLinter(view: EditorView): readonly Diagnostic[] {
  const source = view.state.doc.toString();
  return yamlDiagnostics(source, 0, source.length);
}

function yamlFrontmatterLinter(view: EditorView): readonly Diagnostic[] {
  return yamlFrontmatterDiagnostics(view.state.doc.toString());
}

export function yamlFrontmatterDiagnostics(source: string): readonly Diagnostic[] {
  const opening = /^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!opening) {
    return [{
      from: 0,
      to: Math.min(source.length, Math.max(1, source.indexOf("\n") < 0 ? source.length : source.indexOf("\n"))),
      severity: "error",
      message: "Type definitions need YAML frontmatter between --- markers."
    }];
  }

  const contentFrom = opening[0].length;
  const closing = /^---[ \t]*\r?$/m.exec(source.slice(contentFrom));
  if (!closing) {
    return [{
      from: Math.max(0, source.length - 1),
      to: source.length,
      severity: "error",
      message: "Type definitions need a closing --- frontmatter marker."
    }];
  }

  return yamlDiagnostics(source.slice(contentFrom, contentFrom + closing.index), contentFrom, source.length);
}

function yamlDiagnostics(source: string, offset: number, documentLength: number): readonly Diagnostic[] {
  const parsed = parseYamlDocument(source, { prettyErrors: false });
  return parsed.errors.map((error) => {
    const [start = 0, end = start + 1] = error.pos ?? [];
    const from = Math.min(documentLength, Math.max(0, offset + start));
    const to = Math.min(documentLength, Math.max(from + 1, offset + end));
    return {
      from,
      to,
      severity: "error" as const,
      message: error.message
    };
  });
}

function rememberEditor(documentId: string, view: EditorView, separator: "\n" | "\r\n") {
  rememberedEditors.delete(documentId);
  rememberedEditors.set(documentId, {
    state: view.state.toJSON({ history: historyField }),
    scrollTop: view.scrollDOM.scrollTop,
    separator
  });
  while (rememberedEditors.size > rememberedEditorLimit) {
    const oldest = rememberedEditors.keys().next().value;
    if (typeof oldest !== "string") break;
    rememberedEditors.delete(oldest);
  }
}

function rememberedValue(remembered: RememberedEditor): string | undefined {
  if (!remembered.state || typeof remembered.state !== "object" || !("doc" in remembered.state)) return undefined;
  const doc = (remembered.state as { doc?: unknown }).doc;
  if (typeof doc !== "string") return undefined;
  return restoreLineSeparators(doc, remembered.separator);
}
