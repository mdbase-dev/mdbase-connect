import type { CommentAnchor, CommentAnchorCard } from "@mdbase-dev/ui/comment-anchors";
import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, type CSSProperties, type MutableRefObject, type ReactNode } from "react";
import type { FileAssetSnapshot } from "./file-asset-store";
import type { LinkTargets } from "./collection-links";
import type { LinkSuggestion } from "./links";
import type { CollectionFile, NoteSummary } from "./model";
import type { ResolvedNoteEmbed } from "./note-embeds";
import type { Draft } from "./note-session";
import type { NotePreviewAnchor, NotePreviewSource } from "./NotePreview";
import type { EditorPreferences } from "./preferences";
import type { ResolvedFileReference } from "./use-file-assets";
import type { AttachmentUploader } from "./AttachmentUpload";

const CodeEditor = lazy(() => import("./CodeEditor").then((module) => ({ default: module.CodeEditor })));

interface MarkdownNoteEditorProps {
  editorKey: string;
  footer: ReactNode;
  draft: Pick<Draft, "title" | "body">;
  preferences: EditorPreferences;
  documentId?: string;
  currentPath: string;
  linkTargets?: LinkTargets;
  recentPaths: string[];
  linkSuggestions: LinkSuggestion[];
  linkTypes: string[];
  embeddedFiles: ResolvedFileReference[];
  embeddedNotes: ResolvedNoteEmbed[];
  files: CollectionFile[];
  notes: NoteSummary[];
  insertion?: { id: number; text: string; block?: boolean };
  onUploadAttachment?: AttachmentUploader;
  remoteApplyToken?: number;
  onTitleChange: (title: string) => void;
  onTitleVisibilityChange: (visible: boolean) => void;
  onBodyChange: (body: string) => void;
  onOpenLink: (path: string) => void;
  onCreateLink: (target: string, label: string | undefined, format: "wikilink" | "markdown") => void;
  onPreviewLink: (path: string, anchor: NotePreviewAnchor, source: NotePreviewSource) => void;
  onDismissLinkPreview: () => void;
  onOpenFile: (asset: Extract<FileAssetSnapshot, { status: "ready" }>) => void;
  onOpenFileLink: (file: CollectionFile) => void;
  onVisibleFileEmbeds: (keys: string[]) => void;
  onVisibleNoteEmbeds: (keys: string[]) => void;
  autoFocus?: boolean;
  readOnly?: boolean;
  provenance?: ReactNode;
  titlePlaceholder?: string;
  focusTitle?: string;
  titleProperties?: ReactNode;
  onTitleCommit?: () => void;
  /** The note's open comment threads, shown on the passages they are about. */
  commentAnchors?: readonly CommentAnchor[];
  activeComment?: string | null;
  commentReveal?: { id: string; token: number };
  onCommentAnchor?: (id: string) => void;
  commentCard?: (id: string) => CommentAnchorCard | null;
}

interface NoteHeaderProps {
  title: string;
  readOnly: boolean;
  provenance?: ReactNode;
  /** What an empty title asks for: a new note of a type names its title field. */
  titlePlaceholder?: string;
  /** Names a new note; its title takes the focus when the note opens. */
  focusTitle?: string;
  /** Fields shown under the title: what a new note's type requires before it can be saved. */
  properties?: ReactNode;
  onTitleChange: (title: string) => void;
  /** Focus left the title and the fields under it. */
  onTitleCommit?: () => void;
  onTitleVisibilityChange: (visible: boolean) => void;
  /** Where the caret was in a title that had the focus, held while the header moves into the loaded editor. */
  caret: MutableRefObject<TitleCaret | undefined>;
  /** The editor the title belongs to: a held caret is for the same note only. */
  editorKey: string;
}

interface TitleCaret { editorKey: string; start: number; end: number }

function NoteHeader({ title, readOnly, provenance, titlePlaceholder, focusTitle, properties, onTitleChange, onTitleCommit, onTitleVisibilityChange, caret, editorKey }: NoteHeaderProps) {
  const field = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    // Without a root, the observer also sees the title clipped by the editor's scroller.
    const observer = new IntersectionObserver(([entry]) => onTitleVisibilityChange(entry.isIntersecting));
    observer.observe(field.current!);
    return () => {
      observer.disconnect();
      onTitleVisibilityChange(true);
    };
  }, [onTitleVisibilityChange]);
  // The header is drawn once beside the loading editor and again inside the loaded one: typing in the title carries on where it was.
  useLayoutEffect(() => {
    const element = input.current!;
    const held = caret.current;
    caret.current = undefined;
    if (held?.editorKey === editorKey) {
      element.focus({ preventScroll: true });
      element.setSelectionRange(held.start, held.end);
    }
    return () => {
      if (globalThis.document.activeElement === element) caret.current = { editorKey, start: element.selectionStart, end: element.selectionEnd };
    };
  }, [caret, editorKey]);
  useEffect(() => { if (focusTitle) input.current!.focus({ preventScroll: true }); }, [focusTitle]);
  /** Enter finishes the title: on to the first field under it, or into the body. */
  const leaveTitle = (heading: HTMLElement) => {
    const next = heading.querySelector<HTMLElement>(".note-heading-properties :is(input, select, textarea, button, [tabindex]):not([disabled], [tabindex='-1'])")
      ?? heading.closest(".cm-editor")?.querySelector<HTMLElement>(".cm-content");
    next?.focus();
  };
  const placeholder = titlePlaceholder ?? t`Untitled`;
  return <>
    {provenance && <div className="note-provenance">{provenance}</div>}
    <div className="note-heading" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) onTitleCommit?.(); }}>
      <label className="sr-only" htmlFor="note-title"><Trans>Note title</Trans></label>
      <div className="note-title-field" ref={field}>
        <span className="note-title-measure" aria-hidden="true">{title || placeholder}{" "}</span>
        <textarea id="note-title" className="title-input" rows={1} value={title} ref={input}
          onChange={(event) => onTitleChange(event.target.value.replace(/[\r\n]+/g, " "))}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            leaveTitle(event.currentTarget.closest<HTMLElement>(".note-heading")!);
          }}
          placeholder={placeholder} spellCheck="true" readOnly={readOnly} aria-readonly={readOnly} />
      </div>
      {properties && <div className="note-heading-properties">{properties}</div>}
    </div>
  </>;
}

export function MarkdownNoteEditor({ editorKey, draft, preferences, documentId, currentPath, linkTargets, recentPaths,
  linkSuggestions, linkTypes, embeddedFiles, embeddedNotes, files, notes, insertion, onUploadAttachment, remoteApplyToken, onTitleChange, onTitleVisibilityChange, onBodyChange,
  onOpenLink, onCreateLink, onPreviewLink, onDismissLinkPreview, onOpenFile, onOpenFileLink,
  onVisibleFileEmbeds, onVisibleNoteEmbeds, footer, autoFocus = true, readOnly = false, provenance,
  titlePlaceholder, focusTitle, titleProperties, onTitleCommit,
  commentAnchors, activeComment, commentReveal, onCommentAnchor, commentCard }: MarkdownNoteEditorProps) {
  useLingui();
  const titleCaret = useRef<TitleCaret | undefined>(undefined);
  const header = <NoteHeader title={draft.title} readOnly={readOnly} provenance={provenance} titlePlaceholder={titlePlaceholder} focusTitle={focusTitle} caret={titleCaret} editorKey={editorKey}
    properties={titleProperties} onTitleChange={onTitleChange} onTitleCommit={onTitleCommit} onTitleVisibilityChange={onTitleVisibilityChange} />;
  return <article className="writing-surface" style={{ "--editor-font-size": `${preferences.fontSize}px` } as CSSProperties}>
    <Suspense fallback={<div className="note-loading"><div className="note-header">{header}</div><div className="body-editor code-editor-loading" role="status" aria-label={t`Loading note editor`} aria-busy="true"><Trans>Preparing editor…</Trans></div></div>}>
      <CodeEditor key={editorKey} value={draft.body} onChange={onBodyChange} label={t`Note body`} language="markdown" readOnly={readOnly}
        variant="writer" placeholder={t`Start writing`} vimEnabled={preferences.vim} lineWrapping={preferences.lineWrapping}
        typewriter={preferences.focusMode && preferences.typewriterScrolling} quietMarkdown={preferences.quietMarkdown} autoFocus={autoFocus} className="body-editor" documentId={documentId}
        currentPath={currentPath} linkTargets={linkTargets} recentPaths={recentPaths} linkSuggestions={linkSuggestions} linkTypes={linkTypes}
        onOpenLink={onOpenLink} onCreateLink={onCreateLink} onPreviewLink={onPreviewLink}
        onDismissLinkPreview={onDismissLinkPreview} embeddedFiles={embeddedFiles} embeddedNotes={embeddedNotes}
        onOpenFile={onOpenFile} files={files} notes={notes} onOpenFileLink={onOpenFileLink}
        onVisibleFileEmbeds={onVisibleFileEmbeds} onVisibleNoteEmbeds={onVisibleNoteEmbeds} insertion={insertion}
        remoteApplyToken={remoteApplyToken} header={header} footer={footer} onUploadAttachment={onUploadAttachment}
        commentAnchors={commentAnchors} activeComment={activeComment} commentReveal={commentReveal}
        onCommentAnchor={onCommentAnchor} commentCard={commentCard} />
    </Suspense>
  </article>;
}
