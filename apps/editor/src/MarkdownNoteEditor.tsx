import { lazy, Suspense, type CSSProperties } from "react";
import type { FileAssetSnapshot } from "./file-asset-store";
import type { LinkSuggestion } from "./links";
import type { CollectionFile, NoteSummary } from "./model";
import type { ResolvedNoteEmbed } from "./note-embeds";
import type { Draft } from "./note-session";
import type { NotePreviewAnchor, NotePreviewSource } from "./NotePreview";
import type { EditorPreferences } from "./preferences";
import type { ResolvedFileReference } from "./use-file-assets";

const CodeEditor = lazy(() => import("./CodeEditor").then((module) => ({ default: module.CodeEditor })));

interface MarkdownNoteEditorProps {
  editorKey: string;
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
}

export function MarkdownNoteEditor({ editorKey, draft, preferences, documentId, currentPath, recentPaths,
  linkSuggestions, linkTypes, embeddedFiles, embeddedNotes, files, notes, insertion, onTitleChange, onBodyChange,
  onOpenLink, onCreateLink, onPreviewLink, onDismissLinkPreview, onOpenFile, onOpenFileLink,
  onVisibleFileEmbeds, onVisibleNoteEmbeds }: MarkdownNoteEditorProps) {
  return <article className="writing-surface" style={{ "--editor-font-size": `${preferences.fontSize}px` } as CSSProperties}>
    <label className="sr-only" htmlFor="note-title">Note title</label>
    <input id="note-title" className="title-input" value={draft.title} onChange={(event) => onTitleChange(event.target.value)} placeholder="Untitled" spellCheck="true" />
    <Suspense fallback={<div className="body-editor code-editor-loading" role="status" aria-label="Loading note editor" aria-busy="true"><span /></div>}>
      <CodeEditor key={editorKey} value={draft.body} onChange={onBodyChange} label="Note body" language="markdown"
        variant="writer" placeholder="Start writing" vimEnabled={preferences.vim} lineWrapping={preferences.lineWrapping}
        quietMarkdown={preferences.quietMarkdown} autoFocus className="body-editor" documentId={documentId}
        currentPath={currentPath} recentPaths={recentPaths} linkSuggestions={linkSuggestions} linkTypes={linkTypes}
        onOpenLink={onOpenLink} onCreateLink={onCreateLink} onPreviewLink={onPreviewLink}
        onDismissLinkPreview={onDismissLinkPreview} embeddedFiles={embeddedFiles} embeddedNotes={embeddedNotes}
        onOpenFile={onOpenFile} files={files} notes={notes} onOpenFileLink={onOpenFileLink}
        onVisibleFileEmbeds={onVisibleFileEmbeds} onVisibleNoteEmbeds={onVisibleNoteEmbeds} insertion={insertion} />
    </Suspense>
  </article>;
}
