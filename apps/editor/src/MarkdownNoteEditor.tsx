import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { lazy, Suspense, type CSSProperties, type ReactNode } from "react";
import type { FileAssetSnapshot } from "./file-asset-store";
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
  footer?: ReactNode;
  draft: Draft;
  preferences: EditorPreferences;
  documentId?: string;
  currentPath: string;
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
}

export function MarkdownNoteEditor({ editorKey, draft, preferences, documentId, currentPath, recentPaths,
  linkSuggestions, linkTypes, embeddedFiles, embeddedNotes, files, notes, insertion, onUploadAttachment, remoteApplyToken, onTitleChange, onBodyChange,
  onOpenLink, onCreateLink, onPreviewLink, onDismissLinkPreview, onOpenFile, onOpenFileLink,
  onVisibleFileEmbeds, onVisibleNoteEmbeds, footer, autoFocus = true, readOnly = false, provenance }: MarkdownNoteEditorProps) {
  useLingui();
  return <article className="writing-surface" style={{ "--editor-font-size": `${preferences.fontSize}px` } as CSSProperties}>
    {provenance && <div className="note-provenance">{provenance}</div>}
    <label className="sr-only" htmlFor="note-title"><Trans>Note title</Trans></label>
    <div className="note-title-field">
      <span className="note-title-measure" aria-hidden="true">{draft.title || t`Untitled`}{" "}</span>
      <textarea id="note-title" className="title-input" rows={1} value={draft.title}
        onChange={(event) => onTitleChange(event.target.value.replace(/[\r\n]+/g, " "))}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault(); }}
        placeholder={t`Untitled`} spellCheck="true" readOnly={readOnly} aria-readonly={readOnly} />
    </div>
    <Suspense fallback={<div className="body-editor code-editor-loading" role="status" aria-label={t`Loading note editor`} aria-busy="true"><Trans>Preparing editor…</Trans></div>}>
      <CodeEditor key={editorKey} value={draft.body} onChange={onBodyChange} label={t`Note body`} language="markdown" readOnly={readOnly}
        variant="writer" placeholder={t`Start writing`} vimEnabled={preferences.vim} lineWrapping={preferences.lineWrapping}
        typewriter={preferences.focusMode && preferences.typewriterScrolling} quietMarkdown={preferences.quietMarkdown} autoFocus={autoFocus} className="body-editor" documentId={documentId}
        currentPath={currentPath} recentPaths={recentPaths} linkSuggestions={linkSuggestions} linkTypes={linkTypes}
        onOpenLink={onOpenLink} onCreateLink={onCreateLink} onPreviewLink={onPreviewLink}
        onDismissLinkPreview={onDismissLinkPreview} embeddedFiles={embeddedFiles} embeddedNotes={embeddedNotes}
        onOpenFile={onOpenFile} files={files} notes={notes} onOpenFileLink={onOpenFileLink}
        onVisibleFileEmbeds={onVisibleFileEmbeds} onVisibleNoteEmbeds={onVisibleNoteEmbeds} insertion={insertion}
        remoteApplyToken={remoteApplyToken} footer={footer} onUploadAttachment={onUploadAttachment} />
    </Suspense>
  </article>;
}
