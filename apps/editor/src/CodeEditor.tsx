import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyField, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { markdown, markdownKeymap, pasteURLAsLink } from "@codemirror/lang-markdown";
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
import type { FileAssetSnapshot } from "./file-asset-store";
import type { ResolvedFileReference } from "./use-file-assets";
import { writerAutocomplete } from "./code-editor-completions";
import { fileEmbedPresentation } from "./code-editor-file-embeds";
import { noteEmbedPresentation } from "./code-editor-note-embeds";
import { referenceDiagnostics } from "./code-editor-reference-diagnostics";
import { writerInteractions } from "./code-editor-writer-interactions";
import type { LinkSuggestion } from "./links";
import { markdownReferences } from "./markdown-references";
import type { ResolvedNoteEmbed } from "./note-embeds";
import type { NotePreviewAnchor, NotePreviewSource } from "./NotePreview";
import type { CollectionFile, NoteSummary } from "./model";

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
  embeddedFiles?: ResolvedFileReference[];
  embeddedNotes?: ResolvedNoteEmbed[];
  onOpenFile?: (asset: Extract<FileAssetSnapshot, { status: "ready" }>) => void;
  files?: CollectionFile[];
  notes?: NoteSummary[];
  onOpenFileLink?: (file: CollectionFile) => void;
  onVisibleFileEmbeds?: (keys: string[]) => void;
  onVisibleNoteEmbeds?: (keys: string[]) => void;
  insertion?: { id: number; text: string; block?: boolean };
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

export { internalLinkPathAt } from "./code-editor-writer-interactions";
export { linkCompletion, mentionScope } from "./code-editor-completions";

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
  embeddedFiles = [],
  embeddedNotes = [],
  onOpenFile,
  files = [],
  notes = [],
  onOpenFileLink,
  onVisibleFileEmbeds,
  onVisibleNoteEmbeds,
  insertion,
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
  const fileEmbeds = useRef(new Compartment());
  const noteEmbeds = useRef(new Compartment());
  const writerLint = useRef(new Compartment());
  const interactionMode = useRef(new Compartment());
  const editorAttributes = useRef(new Compartment());
  const placeholderMode = useRef(new Compartment());
  const linkSuggestionsRef = useRef(linkSuggestions);
  const linkTypesRef = useRef(linkTypes);
  const recentPathsRef = useRef(recentPaths);
  const currentPathRef = useRef(currentPath);
  const onOpenLinkRef = useRef(onOpenLink);
  const onCreateLinkRef = useRef(onCreateLink);
  const onPreviewLinkRef = useRef(onPreviewLink);
  const onDismissLinkPreviewRef = useRef(onDismissLinkPreview);
  const embeddedFilesRef = useRef(embeddedFiles);
  const embeddedNotesRef = useRef(embeddedNotes);
  const onOpenFileRef = useRef(onOpenFile);
  const filesRef = useRef(files);
  const notesRef = useRef(notes);
  const onOpenFileLinkRef = useRef(onOpenFileLink);
  const onVisibleFileEmbedsRef = useRef(onVisibleFileEmbeds);
  const onVisibleNoteEmbedsRef = useRef(onVisibleNoteEmbeds);
  const appliedInsertion = useRef<number | undefined>(undefined);
  const lineSeparator = useRef(lineSeparatorFor(value));

  linkSuggestionsRef.current = linkSuggestions;
  linkTypesRef.current = linkTypes;
  recentPathsRef.current = recentPaths;
  currentPathRef.current = currentPath;
  onOpenLinkRef.current = onOpenLink;
  onCreateLinkRef.current = onCreateLink;
  onPreviewLinkRef.current = onPreviewLink;
  onDismissLinkPreviewRef.current = onDismissLinkPreview;
  embeddedFilesRef.current = embeddedFiles;
  embeddedNotesRef.current = embeddedNotes;
  onOpenFileRef.current = onOpenFile;
  filesRef.current = files;
  notesRef.current = notes;
  onOpenFileLinkRef.current = onOpenFileLink;
  onVisibleFileEmbedsRef.current = onVisibleFileEmbeds;
  onVisibleNoteEmbedsRef.current = onVisibleNoteEmbeds;

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
        () => recentPathsRef.current,
        () => filesRef.current,
        () => notesRef.current
      ) : []),
      writerLint.current.of(variant === "writer" && language === "markdown" ? referenceDiagnostics(
        () => linkSuggestionsRef.current,
        () => filesRef.current,
        () => notesRef.current,
        () => currentPathRef.current
      ) : []),
      writerPresentation.current.of(variant === "writer" && quietMarkdown ? quietMarkdownPresentation : []),
      fileEmbeds.current.of(variant === "writer" && language === "markdown" ? fileEmbedPresentation(
        () => embeddedFilesRef.current,
        () => onOpenFileRef.current,
        () => onVisibleFileEmbedsRef.current
      ) : []),
      noteEmbeds.current.of(variant === "writer" && language === "markdown" ? noteEmbedPresentation(
        () => embeddedNotesRef.current,
        () => onOpenLinkRef.current,
        () => onVisibleNoteEmbedsRef.current
      ) : []),
      variant === "writer" ? writerInteractions(
        () => linkSuggestionsRef.current,
        () => filesRef.current,
        () => currentPathRef.current,
        () => onOpenLinkRef.current,
        () => onOpenFileLinkRef.current,
        () => onCreateLinkRef.current,
        () => onPreviewLinkRef.current,
        () => onDismissLinkPreviewRef.current
      ) : [],
      interactionMode.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
      editorAttributes.current.of(EditorView.contentAttributes.of({
        "aria-label": label,
        "aria-multiline": "true",
        tabindex: "0",
        spellcheck: variant === "writer" && language === "markdown" ? "true" : "false"
      })),
      placeholderMode.current.of(placeholder ? editorPlaceholder(placeholder) : []),
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
        () => recentPathsRef.current,
        () => filesRef.current,
        () => notesRef.current
      ) : [])
    });
  }, [language, variant]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: writerLint.current.reconfigure(
      variant === "writer" && language === "markdown" ? referenceDiagnostics(
        () => linkSuggestionsRef.current,
        () => filesRef.current,
        () => notesRef.current,
        () => currentPathRef.current
      ) : []
    ) });
  }, [currentPath, files, language, linkSuggestions, notes, variant]);

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
    view.dispatch({
      effects: fileEmbeds.current.reconfigure(
        variant === "writer" && language === "markdown" ? fileEmbedPresentation(
          () => embeddedFilesRef.current,
          () => onOpenFileRef.current,
          () => onVisibleFileEmbedsRef.current
        ) : []
      )
    });
  }, [embeddedFiles, language, onOpenFile, onVisibleFileEmbeds, variant]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: noteEmbeds.current.reconfigure(
        variant === "writer" && language === "markdown" ? noteEmbedPresentation(
          () => embeddedNotesRef.current,
          () => onOpenLinkRef.current,
          () => onVisibleNoteEmbedsRef.current
        ) : []
      )
    });
  }, [embeddedNotes, language, onOpenLink, onVisibleNoteEmbeds, variant]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: interactionMode.current.reconfigure([
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly)
    ]) });
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: editorAttributes.current.reconfigure(EditorView.contentAttributes.of({
      "aria-label": label,
      "aria-multiline": "true",
      tabindex: "0",
      spellcheck: variant === "writer" && language === "markdown" ? "true" : "false"
    })) });
  }, [label, language, variant]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: placeholderMode.current.reconfigure(placeholder ? editorPlaceholder(placeholder) : []) });
  }, [placeholder]);

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

  useEffect(() => {
    const view = viewRef.current;
    if (!view || readOnly || !insertion || appliedInsertion.current === insertion.id) return;
    appliedInsertion.current = insertion.id;
    const selection = view.state.selection.main;
    const before = selection.from > 0 ? view.state.doc.sliceString(selection.from - 1, selection.from) : "";
    const after = selection.to < view.state.doc.length ? view.state.doc.sliceString(selection.to, selection.to + 1) : "";
    const insert = insertion.block
      ? `${before && before !== "\n" ? "\n\n" : ""}${insertion.text}${after && after !== "\n" ? "\n\n" : ""}`
      : insertion.text;
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert },
      selection: EditorSelection.cursor(selection.from + insert.length),
      scrollIntoView: true
    });
    view.focus();
  }, [insertion, readOnly]);

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
  variant === "writer" ? [scrollPastEnd(), pasteURLAsLink] : [
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
    ...lintKeymap
  ])
];

const writerKeymap = [
  { key: "Mod-b", run: markdownFormatCommand("bold") },
  { key: "Mod-i", run: markdownFormatCommand("italic") },
  { key: "Mod-k", run: markdownFormatCommand("link") },
  { key: "Mod-Shift-c", run: markdownFormatCommand("code") },
  { key: "Tab", run: indentMarkdownList },
  { key: "Shift-Tab", run: outdentMarkdownList },
  ...markdownKeymap
];

function indentMarkdownList(view: EditorView): boolean {
  return selectionIsMarkdownList(view) ? indentMore(view) : false;
}

function outdentMarkdownList(view: EditorView): boolean {
  return selectionIsMarkdownList(view) ? indentLess(view) : false;
}

function selectionIsMarkdownList(view: EditorView): boolean {
  return view.state.selection.ranges.every((range) => (
    /^\s*(?:[-+*]|\d+[.)])\s+/.test(view.state.doc.lineAt(range.head).text)
  ));
}

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

class MarkdownLinkWidget extends WidgetType {
  constructor(readonly from: number, readonly label: string, readonly target: string) {
    super();
  }

  eq(other: MarkdownLinkWidget) {
    return this.from === other.from && this.label === other.label && this.target === other.target;
  }

  toDOM() {
    const link = document.createElement("a");
    link.className = "cm-rendered-link";
    link.dataset.linkFrom = String(this.from);
    link.href = /^https?:\/\//i.test(this.target) ? this.target : "#";
    if (/^https?:\/\//i.test(this.target)) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    link.textContent = this.label;
    return link;
  }

  ignoreEvent() {
    return false;
  }
}

function markdownDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const activeLines = new Set(view.state.selection.ranges.map((range) => view.state.doc.lineAt(range.head).from));
  const renderedLinks: Array<{ from: number; to: number }> = [];
  const source = view.state.doc.toString();
  const references = markdownReferences(source, syntaxTree(view.state));
  for (const reference of references) {
    if (reference.kind !== "link") continue;
    if (!view.visibleRanges.some((visible) => reference.from <= visible.to && reference.to >= visible.from)) continue;
    if (activeLines.has(view.state.doc.lineAt(reference.from).from)) continue;
    const target = `${reference.target}${reference.anchor ? `#${reference.anchor}` : ""}`;
    renderedLinks.push({ from: reference.from, to: reference.to });
    ranges.push(Decoration.replace({
      widget: new MarkdownLinkWidget(reference.from, reference.label ?? target, target)
    }).range(reference.from, reference.to));
  }

  const visibleLines = new Set<number>();
  for (const visible of view.visibleRanges) {
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
    syntaxTree(view.state).iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        if (!markdownMarkerNames.has(node.name) || activeLines.has(view.state.doc.lineAt(node.from).from)) return;
        if (renderedLinks.some((link) => node.from < link.to && node.to > link.from)) return;
        ranges.push(Decoration.mark({ class: "cm-markdown-mark" }).range(node.from, node.to));
      }
    });
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
