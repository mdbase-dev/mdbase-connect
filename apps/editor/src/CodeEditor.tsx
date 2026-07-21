import { autocompletion, startCompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, placeholder as editorPlaceholder } from "@codemirror/view";
import { minimalSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { linkMatches, wikilinkFor, type LinkSuggestion } from "./links";

type EditorLanguage = "markdown" | "json" | "yaml" | "plain";

interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  label: string;
  language?: EditorLanguage;
  placeholder?: string;
  readOnly?: boolean;
  vimEnabled?: boolean;
  lineWrapping?: boolean;
  autoFocus?: boolean;
  className?: string;
  linkSuggestions?: LinkSuggestion[];
  linkTypes?: string[];
}

export function CodeEditor({
  value,
  onChange,
  label,
  language = "plain",
  placeholder,
  readOnly = false,
  vimEnabled = false,
  lineWrapping = true,
  autoFocus = false,
  className = "",
  linkSuggestions = [],
  linkTypes = []
}: CodeEditorProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  const syncing = useRef(false);
  const vimMode = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  const completions = useRef(new Compartment());

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  useEffect(() => {
    if (!parentRef.current) return;
    const view = new EditorView({
      parent: parentRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          vimMode.current.of([]),
          minimalSetup,
          languageExtension(language),
          wrapping.current.of(lineWrapping ? EditorView.lineWrapping : []),
          completions.current.of(language === "markdown" && linkSuggestions.length ? linkAutocomplete(linkSuggestions, linkTypes) : []),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.contentAttributes.of({
            "aria-label": label,
            "aria-multiline": "true",
            spellcheck: language === "markdown" ? "true" : "false"
          }),
          placeholder ? editorPlaceholder(placeholder) : [],
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !syncing.current) {
              onChangeRef.current?.(update.state.doc.toString());
            }
          })
        ]
      })
    });
    viewRef.current = view;
    if (autoFocus) requestAnimationFrame(() => view.focus());
    return () => {
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
    void import("@replit/codemirror-vim").then(({ vim }) => {
      if (!cancelled && viewRef.current === view) {
        view.dispatch({ effects: vimMode.current.reconfigure(vim()) });
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
      effects: completions.current.reconfigure(language === "markdown" && linkSuggestions.length ? linkAutocomplete(linkSuggestions, linkTypes) : [])
    });
  }, [language, linkSuggestions, linkTypes]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    syncing.current = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    syncing.current = false;
  }, [value]);

  return <div ref={parentRef} className={`code-editor${vimEnabled ? " vim-enabled" : ""} ${className}`.trim()} />;
}

function languageExtension(language: EditorLanguage): Extension {
  if (language === "markdown") return markdown();
  if (language === "json") return json();
  if (language === "yaml") return yaml();
  return [];
}

function linkAutocomplete(suggestions: LinkSuggestion[], types: string[]): Extension {
  return autocompletion({
    activateOnTyping: true,
    override: [(context) => linkCompletion(context, suggestions, types)]
  });
}

export function linkCompletion(context: CompletionContext, suggestions: LinkSuggestion[], types: string[]) {
  const wikilink = context.matchBefore(/\[\[[^\]\n]*/);
  const mention = context.matchBefore(/(?:^|[\s([{])@[^@\n]*/);
  if (!wikilink && !mention) return null;
  if (wikilink && (!mention || wikilink.from > mention.from)) {
    const query = wikilink.text.slice(2);
    return objectCompletions(wikilink.from + 2, context.pos, suggestions, query);
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
        detail: "mdbase type",
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
    options.push(...objectOptions(suggestions, scope.query, scope.type, true));
  }
  return { from, to: context.pos, options, filter: false };
}

function objectCompletions(from: number, to: number, suggestions: LinkSuggestion[], query: string) {
  return { from, to, options: objectOptions(suggestions, query), filter: false };
}

function objectOptions(suggestions: LinkSuggestion[], query: string, type?: string, mention = false): Completion[] {
  return linkMatches(suggestions, query, type, 50).map(({ suggestion, label }) => ({
    label,
    detail: suggestionDetail(suggestion, label),
    type: "text",
    apply: mention ? `[[${wikilinkFor(suggestion, label)}]]` : `${wikilinkFor(suggestion, label)}]]`
  }));
}

function suggestionDetail(suggestion: LinkSuggestion, label: string): string {
  const parts = [suggestion.types?.length ? suggestion.types.join(", ") : "untyped"];
  if (label !== suggestion.title) parts.push(suggestion.title);
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
