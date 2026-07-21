import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, placeholder as editorPlaceholder } from "@codemirror/view";
import { minimalSetup } from "codemirror";
import { useEffect, useRef } from "react";

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
  className = ""
}: CodeEditorProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  const syncing = useRef(false);
  const vimMode = useRef(new Compartment());
  const wrapping = useRef(new Compartment());

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
    if (!view || view.state.doc.toString() === value) return;
    syncing.current = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    syncing.current = false;
  }, [value]);

  return <div ref={parentRef} className={`code-editor ${className}`.trim()} />;
}

function languageExtension(language: EditorLanguage): Extension {
  if (language === "markdown") return markdown();
  if (language === "json") return json();
  if (language === "yaml") return yaml();
  return [];
}
