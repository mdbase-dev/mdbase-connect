import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { livePreview, markdownMath } from "@mdbase-dev/ui/live-preview";
import { useEffect, useRef, type JSX } from "react";

/** A record's body as the Editor renders it, read-only: the live preview never reveals source without focus. */
export function MarkdownBody({ text, label }: { readonly text: string; readonly label: string }): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": label }),
          markdown({ base: markdownLanguage, extensions: [markdownMath] }),
          livePreview(),
        ],
      }),
    });
    return () => view.destroy();
  }, [text, label]);
  return <div className="view-body" ref={host} />;
}
