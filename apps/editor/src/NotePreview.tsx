import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import type { CollectionGateway, NoteDocument, NoteSummary } from "./model";
import { noteTitle } from "./note";

export interface NotePreviewAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export type NotePreviewSource = "sidebar" | "editor";

interface NotePreviewState {
  path: string;
  title: string;
  body?: string;
  types: string[];
  frontmatter: Record<string, unknown>;
  anchor: NotePreviewAnchor;
  source: NotePreviewSource;
  loading: boolean;
  unavailable: boolean;
}

interface PreviewIntent {
  path: string;
  anchor: NotePreviewAnchor;
  source: NotePreviewSource;
}

export interface NotePreviewController {
  preview?: NotePreviewState;
  request: (path: string, anchor: NotePreviewAnchor, source: NotePreviewSource) => void;
  dismiss: () => void;
}

const previewDelay = 360;
const previewId = "note-preview-popover";

export function useNotePreview(
  gateway: CollectionGateway,
  notes: NoteSummary[],
  types: CollectionTypeDescriptor[] = []
): NotePreviewController {
  const notesRef = useRef(notes);
  const cache = useRef(new Map<string, NoteDocument>());
  const intent = useRef<PreviewIntent | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const requestGeneration = useRef(0);
  const [preview, setPreview] = useState<NotePreviewState>();

  notesRef.current = notes;

  const dismiss = useCallback(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
    intent.current = undefined;
    requestGeneration.current += 1;
    setPreview(undefined);
  }, []);

  const open = useCallback((next: PreviewIntent) => {
    const note = notesRef.current.find((candidate) => candidate.path === next.path);
    if (!note || intent.current?.path !== next.path || intent.current.source !== next.source) return;

    const cached = cache.current.get(next.path);
    const cachedCurrent = cached && (
      !("revision" in note)
      || !note.revision
      || cached.revision === note.revision
    ) ? cached : undefined;
    const indexedBody = typeof note.body === "string" ? note.body : undefined;
    const body = indexedBody ?? cachedCurrent?.body;

    setPreview({
      path: note.path,
      title: noteTitle(note, types),
      body,
      types: note.types,
      frontmatter: note.effectiveFrontmatter,
      anchor: next.anchor,
      source: next.source,
      loading: body === undefined,
      unavailable: false
    });
    if (body !== undefined) return;

    const generation = ++requestGeneration.current;
    void gateway.read(note.path).then((document) => {
      cache.current.set(note.path, document);
      if (
        generation !== requestGeneration.current
        || intent.current?.path !== note.path
        || intent.current.source !== next.source
      ) return;
      setPreview({
        path: document.path,
        title: noteTitle(document, types),
        body: document.body ?? "",
        types: document.types,
        frontmatter: document.effectiveFrontmatter,
        anchor: next.anchor,
        source: next.source,
        loading: false,
        unavailable: false
      });
    }).catch(() => {
      if (
        generation !== requestGeneration.current
        || intent.current?.path !== note.path
        || intent.current.source !== next.source
      ) return;
      setPreview((current) => current ? { ...current, loading: false, unavailable: true } : current);
    });
  }, [gateway, types]);

  const request = useCallback((
    path: string,
    anchor: NotePreviewAnchor,
    source: NotePreviewSource
  ) => {
    if (typeof window.matchMedia === "function" && window.matchMedia("(hover: none)").matches) return;
    if (intent.current?.path === path && intent.current.source === source) return;
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    requestGeneration.current += 1;
    intent.current = { path, anchor, source };
    setPreview(undefined);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      open({ path, anchor, source });
    }, previewDelay);
  }, [open]);

  useEffect(() => dismiss, [dismiss]);
  useEffect(() => {
    if (preview && !notes.some((note) => note.path === preview.path)) dismiss();
  }, [dismiss, notes, preview]);

  return { preview, request, dismiss };
}

export function NotePreviewCard({ preview }: { preview?: NotePreviewState }) {
  if (!preview) return null;
  const excerpt = notePreviewExcerpt(preview.body ?? "", preview.title);
  const properties = previewProperties(preview.frontmatter);
  const style = previewPosition(preview.anchor, preview.source);

  return createPortal(
    <aside
      id={previewId}
      className={`note-preview note-preview-${preview.source}`}
      role="tooltip"
      aria-label={`Preview of ${preview.title}`}
      style={style}
    >
      <header>
        <strong>{preview.title}</strong>
        <span>{preview.path}</span>
      </header>
      {preview.loading
        ? <div className="note-preview-loading" aria-label="Loading preview" aria-busy="true"><i /><i /><i /></div>
        : preview.unavailable
          ? <p className="note-preview-empty">Preview unavailable.</p>
          : excerpt
            ? <p className="note-preview-excerpt">{excerpt}</p>
            : <p className="note-preview-empty">No text preview.</p>}
      {(preview.types.length > 0 || properties.length > 0) && <footer>
        {preview.types.length > 0 && <div className="note-preview-types" aria-label="Note types">
          {preview.types.slice(0, 3).map((type) => <span key={type}>{type}</span>)}
          {preview.types.length > 3 && <span>+{preview.types.length - 3}</span>}
        </div>}
        {properties.length > 0 && <dl>
          {properties.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
        </dl>}
      </footer>}
    </aside>,
    document.body
  );
}

export function notePreviewExcerpt(body: string, title = "", limit = 280): string {
  const withoutFences = body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ");
  const paragraphs = withoutFences
    .split(/\n\s*\n/)
    .map((paragraph) => cleanMarkdown(paragraph))
    .filter(Boolean)
    .filter((paragraph) => paragraph.localeCompare(title, undefined, { sensitivity: "base" }) !== 0);
  const excerpt = paragraphs[0] ?? "";
  if (excerpt.length <= limit) return excerpt;
  const clipped = excerpt.slice(0, limit + 1);
  const wordBoundary = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, wordBoundary > limit * 0.7 ? wordBoundary : limit).trimEnd()}…`;
}

export function previewProperties(frontmatter: Record<string, unknown>): Array<[string, string]> {
  const hidden = new Set(["title", "name", "subject", "type", "types", "aliases", "alias", "tags"]);
  return Object.entries(frontmatter)
    .filter(([name]) => !hidden.has(name.toLocaleLowerCase()))
    .flatMap(([name, value]): Array<[string, string]> => {
      if (typeof value === "string" && value.trim()) return [[name, compactValue(value)]];
      if (typeof value === "number" || typeof value === "boolean") return [[name, String(value)]];
      return [];
    })
    .slice(0, 3);
}

export function notePreviewPopoverId(): string {
  return previewId;
}

function cleanMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*_~`]+/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactValue(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 72 ? `${compact.slice(0, 69).trimEnd()}…` : compact;
}

function previewPosition(
  anchor: NotePreviewAnchor,
  source: NotePreviewSource
): CSSProperties {
  const gap = 12;
  const margin = 12;
  const width = Math.min(336, window.innerWidth - margin * 2);
  const estimatedHeight = 310;
  let left: number;
  let top: number;

  if (source === "sidebar") {
    left = anchor.right + gap;
    if (left + width > window.innerWidth - margin) left = anchor.left - width - gap;
    top = anchor.top - 10;
  } else {
    left = anchor.left;
    top = anchor.bottom + gap;
    if (top + estimatedHeight > window.innerHeight - margin) top = anchor.top - estimatedHeight - gap;
  }

  return {
    left: Math.max(margin, Math.min(left, window.innerWidth - width - margin)),
    top: Math.max(margin, Math.min(top, window.innerHeight - estimatedHeight - margin)),
    width
  };
}
