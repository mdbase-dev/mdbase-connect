import { t } from "@lingui/core/macro";
import { MdbaseConnectError } from "@mdbase-dev/connect";
import { i18n } from "@lingui/core";
import type { CommentAnchor, CommentAnchorCard } from "@mdbase-dev/ui/comment-anchors";
import {
  NO_COMMENT_PEOPLE,
  RecordPaths,
  applySuggestion,
  bodyHash,
  changeFields,
  codePointOffset,
  commentPath,
  newCommentFields,
  personName,
  placeThreads,
  recordThreads,
  targetFor,
  when,
  type CommentChange,
  type CommentPeople,
  type CommentRecord,
  type CommentTarget,
  type CommentThread,
  type PlacedThread,
} from "@mdbase-dev/ui/comments";
import type { CommentResult, PendingComment } from "@mdbase-dev/ui/comments-panel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CollectionIndexController } from "./collection-index-controller";
import type { CollectionGateway, EditorCollectionDescription, NoteSummary } from "./model";
import { persistedBody, summaryFromDocument } from "./note";
import { collectionComments, commentImplementationOf, commentImplementations, commentPeople, localFields, storedOffset } from "./note-comments";
import type { Draft } from "./note-session";

export interface NoteComments {
  /** The collection has a type that implements mdbase.comment. */
  readonly available: boolean;
  readonly threads: readonly PlacedThread[];
  readonly people: CommentPeople;
  readonly loading: boolean;
  readonly problem?: string;
  retry(): void;
  /** Reads the account's person record again. */
  checkAccount(): void;
  reply(thread: CommentThread, text: string): Promise<CommentResult>;
  change(comment: CommentRecord, change: CommentChange): Promise<CommentResult>;
  /** Open threads on the note. */
  readonly openCount: number;
  /** This person may write comments here now. */
  readonly canWrite: boolean;
  readonly active: string | null;
  readonly pending: PendingComment | null;
  /** Begins a comment on the editor's selection, or on the whole note when nothing is selected. */
  start(): void;
  submit(text: string): Promise<CommentResult>;
  cancel(): void;
  /** Selects a thread and shows its passage in the note. */
  select(placed: PlacedThread): void;
  /** Makes a suggested edit in the note and resolves its thread. */
  accept(placed: PlacedThread): Promise<CommentResult>;
  /** What the note's editor needs to show the threads' passages. */
  readonly editor: {
    commentAnchors: readonly CommentAnchor[];
    activeComment: string | null;
    commentReveal: { id: string; token: number } | undefined;
    onCommentAnchor: (id: string) => void;
    commentCard: (id: string) => CommentAnchorCard | null;
  };
}

/** How the comments reach the rest of the open note's surface. */
export interface CommentSurface {
  /** The comments panel is open (a note with threads reads authors' names either way). */
  readonly panelOpen: boolean;
  openPanel(): void;
  /** The note is on screen and this person may create and edit records. */
  readonly canWrite: boolean;
  /** The editor's selection, as offsets in its text. */
  selection(): { from: number; to: number } | undefined;
  /** Replaces the note's body. */
  applyBody(body: string): void;
}

const failure = (error: unknown): CommentResult => ({ ok: false, message: error instanceof Error ? error.message : t`The comment could not be saved.` });

/**
 * The comments on the open note. Threads come from the collection index, so
 * comments written elsewhere arrive with every other change; writes go
 * through the gateway and into the same index.
 */
export function useNoteComments({ gateway, description, notes, path, draft, indexController, surface }: {
  gateway: CollectionGateway;
  description: EditorCollectionDescription | undefined;
  notes: readonly NoteSummary[];
  /** The open note. */
  path: string | undefined;
  draft: Draft | undefined;
  indexController: Pick<CollectionIndexController, "create" | "upsert">;
  surface: CommentSurface;
}): NoteComments {
  const wanted = surface.panelOpen;
  const implementations = useMemo(() => commentImplementations(description), [description]);
  const available = implementations.length > 0;
  // Bodies the index has not hydrated, by path, good for one revision.
  const [bodies, setBodies] = useState<ReadonlyMap<string, { revision: string | undefined; body: string }>>(new Map());
  const [problem, setProblem] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [people, setPeople] = useState<CommentPeople>(NO_COMMENT_PEOPLE);
  const [accountCheck, setAccountCheck] = useState(0);

  const commentNotes = useMemo(() => available ? notes.filter((note) => commentImplementationOf(note, implementations)) : [], [available, notes, implementations]);
  const paths = useMemo(() => new RecordPaths(available ? notes.map((note) => note.path) : []), [available, notes]);
  const readBodies = useMemo(() => {
    const current = new Map<string, string>();
    for (const note of commentNotes) {
      const read = bodies.get(note.path);
      if (read && read.revision === note.revision) current.set(note.path, read.body);
    }
    return current;
  }, [commentNotes, bodies]);
  const comments = useMemo(() => collectionComments(commentNotes, implementations, readBodies), [commentNotes, implementations, readBodies]);
  const threads = useMemo(() => path ? recordThreads(path, comments, paths) : [], [path, comments, paths]);

  const unread = useMemo(() => {
    const onNote = new Set(threads.flatMap((thread) => [thread.root.path, ...thread.replies.map((reply) => reply.path)]));
    return commentNotes.filter((note) => onNote.has(note.path) && note.body === undefined && !readBodies.has(note.path));
  }, [threads, commentNotes, readBodies]);
  useEffect(() => {
    if (!unread.length) return;
    let cancelled = false;
    void Promise.all(unread.map(async (note) => [note.path, { revision: note.revision, body: (await gateway.read(note.path)).body ?? "" }] as const))
      .then((read) => { if (!cancelled) { setProblem(undefined); setBodies((current) => new Map([...current, ...read])); } })
      .catch((error: unknown) => { if (!cancelled) setProblem(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a failed read waits for Try again
  }, [gateway, unread.map((note) => `${note.path}@${note.revision ?? ""}`).join("\n"), attempt]);
  useEffect(() => { setBodies(new Map()); setProblem(undefined); setPeople(NO_COMMENT_PEOPLE); }, [gateway, description?.collectionId]);

  const peopleWanted = available && (wanted || threads.length > 0);
  useEffect(() => {
    if (!peopleWanted || !gateway.peopleDirectory) return;
    const controller = new AbortController();
    gateway.peopleDirectory({ signal: controller.signal }).then(
      (directory) => { if (!controller.signal.aborted) setPeople(commentPeople(directory)); },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        // Without the account, person names are unknown and comments go unsigned.
        setPeople({
          names: new Map(),
          signing: error instanceof MdbaseConnectError && error.code === "access_denied"
            ? { kind: "not-approved" }
            : { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) },
        });
      },
    );
    return () => controller.abort();
  }, [gateway, description?.collectionId, peopleWanted, accountCheck]);

  // What the note's record holds: a heading title is part of the stored body,
  // and the editor's text starts after it.
  const stored = draft ? persistedBody(draft.title, draft.body, draft.source) : "";
  const lead = draft && stored.endsWith(draft.body) ? stored.length - draft.body.length : undefined;
  const placed = useMemo(() => placeThreads(threads, stored), [threads, stored]);
  const leadPoints = lead === undefined ? undefined : codePointOffset(stored, lead);
  const placedAnchors = placed.flatMap(({ thread: { root }, at }): CommentAnchor[] => {
    if (root.status !== "open" || !root.target || at === null || at === "whole") return [];
    return [{
      id: root.path,
      target: editorPosition(root.target, leadPoints),
      ...(root.motivation === "editing" && root.suggestion ? { replacement: root.suggestion.replacement } : {}),
    }];
  });
  // The body changes with every keystroke but the anchors rarely do, and the
  // editor redraws them whenever this array is a new one.
  const anchorsKey = JSON.stringify(placedAnchors);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the key is the anchors' content
  const anchors = useMemo(() => placedAnchors, [anchorsKey]);

  const latest = useRef({ draft, stored, lead, path, people, implementations, notes, surface, placed });
  latest.current = { draft, stored, lead, path, people, implementations, notes, surface, placed };

  const write = useCallback(async (fields: ReturnType<typeof newCommentFields>, text: string): Promise<CommentResult> => {
    const implementation = latest.current.implementations[0];
    if (!implementation) return { ok: false, message: t`Comments are not set up in this collection.` };
    try {
      const created = await gateway.create({
        id: crypto.randomUUID(),
        title: "",
        body: text.trim(),
        path: commentPath(new Date()),
        type: implementation.typeName,
        // A comment has no title: its body is its text, written as it is.
        titleField: implementation.fields.document ?? implementation.fields["/document"] ?? "document",
        properties: localFields(fields, implementation),
      });
      indexController.create(summaryFromDocument(created));
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  }, [gateway, indexController]);

  const create = useCallback(async (text: string, selection: { from: number; to: number } | null) => {
    const { draft: current, stored: body, lead: offset, path: document, people: who } = latest.current;
    if (!current || !document) return { ok: false, message: t`Open a note to comment on it.` } as const;
    let target: CommentTarget | undefined;
    if (selection) {
      const from = storedOffset(current.body, selection.from);
      const to = storedOffset(current.body, selection.to);
      if (offset === undefined) {
        // The stored body cannot be lined up with the editor's text, so the quote alone anchors it.
        const { quote } = targetFor(current.body, from, to, "");
        target = { quote };
      } else target = targetFor(body, offset + from, offset + to, await bodyHash(body));
    }
    return write(newCommentFields({ document, ...(target ? { target } : {}) }, new Date(), who.me?.link), text);
  }, [write]);

  const reply = useCallback((thread: CommentThread, text: string) => {
    const { path: document, people: who } = latest.current;
    if (!document) return Promise.resolve<CommentResult>({ ok: false, message: t`Open a note to comment on it.` });
    return write(newCommentFields({ document, thread: thread.root }, new Date(), who.me?.link), text);
  }, [write]);

  const change = useCallback(async (comment: CommentRecord, kind: CommentChange): Promise<CommentResult> => {
    const { implementations: types, people: who } = latest.current;
    try {
      const current = await gateway.read(comment.path);
      const implementation = commentImplementationOf(current, types);
      if (!implementation) return { ok: false, message: t`${comment.path} is no longer a comment.` };
      const { fields, body } = changeFields(comment, kind, new Date(), who.me?.link);
      const updated = await gateway.update(current, { patch: localFields(fields, implementation, current.frontmatter), ...(body === undefined ? {} : { body }) });
      indexController.upsert(summaryFromDocument(updated));
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  }, [gateway, indexController]);

  const [active, setActive] = useState<string | null>(null);
  // A comment being written: on a passage (offsets in the editor's text) or on the whole note.
  const [pending, setPending] = useState<{ selection: { from: number; to: number; quote: string } | null } | null>(null);
  const [reveal, setReveal] = useState<{ id: string; token: number }>();
  useEffect(() => { setActive(null); setPending(null); }, [path]);
  const canWrite = available && surface.canWrite && Boolean(path && draft);

  const start = useCallback(() => {
    const { draft: current, surface: on } = latest.current;
    if (!current || !canWrite) return;
    const selection = on.selection();
    const text = current.body.replace(/\r\n/g, "\n");
    setPending({ selection: selection && selection.to > selection.from ? { ...selection, quote: text.slice(selection.from, selection.to) } : null });
    on.openPanel();
  }, [canWrite]);
  useEffect(() => {
    if (!canWrite) return;
    // Option changes the letter a Mac keyboard reports, so this goes by the key itself.
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.altKey || event.shiftKey || event.code !== "KeyM") return;
      event.preventDefault();
      start();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canWrite, start]);

  const submit = useCallback(async (text: string): Promise<CommentResult> => {
    const { draft: current } = latest.current;
    if (!pending || !current) return { ok: false, message: t`Open a note to comment on it.` };
    let selection: { from: number; to: number } | null = null;
    if (pending.selection) {
      // The note may have been edited since the passage was chosen: find it where it is now.
      const { from, to, quote } = pending.selection;
      const body = current.body.replace(/\r\n/g, "\n");
      const at = body.slice(from, to) === quote ? from : body.indexOf(quote);
      if (at < 0) return { ok: false, message: t`That passage is no longer in the note. Select it again to comment on it.` };
      selection = { from: at, to: at + quote.length };
    }
    const result = await create(text, selection);
    if (result.ok) setPending(null);
    return result;
  }, [pending, create]);

  const accept = useCallback(async (placedThread: PlacedThread): Promise<CommentResult> => {
    const { root } = placedThread.thread;
    const { draft: current, stored: body, lead: offset, surface: on } = latest.current;
    const next = current && offset !== undefined && root.target && root.suggestion
      ? applySuggestion(body, root.target, root.suggestion.replacement) : null;
    // A suggestion that reaches into the title is not the body editor's to make.
    if (next === null || offset === undefined || next.slice(0, offset) !== body.slice(0, offset)) {
      return { ok: false, message: t`This edit cannot be made here: its passage is no longer in the note’s text.` };
    }
    on.applyBody(next.slice(offset));
    return change(root, { kind: "resolve", outcome: "accepted" });
  }, [change]);

  const select = useCallback((placedThread: PlacedThread) => {
    const id = placedThread.thread.root.path;
    setActive(id);
    setReveal((current) => ({ id, token: (current?.token ?? 0) + 1 }));
  }, []);
  const commentCard = useCallback((id: string): CommentAnchorCard | null => {
    const thread = latest.current.placed.find((each) => each.thread.root.path === id)?.thread;
    return thread ? {
      kind: thread.root.motivation === "editing" ? "suggestion" : "comment",
      author: personName(thread.root.createdBy, latest.current.people) ?? t`Unsigned`,
      when: when(thread.root.createdAt, i18n.locale),
      text: thread.root.text,
      replies: thread.replies.length,
    } : null;
  }, []);
  const editor = useMemo(() => ({ commentAnchors: anchors, activeComment: active, commentReveal: reveal, onCommentAnchor: setActive, commentCard }), [anchors, active, reveal, commentCard]);

  return {
    available,
    threads: placed,
    people,
    loading: unread.length > 0 && !problem,
    ...(problem ? { problem } : {}),
    retry: useCallback(() => { setProblem(undefined); setAttempt((value) => value + 1); }, []),
    checkAccount: useCallback(() => setAccountCheck((value) => value + 1), []),
    reply,
    change,
    openCount: useMemo(() => placed.filter((each) => each.thread.root.status === "open").length, [placed]),
    canWrite,
    active,
    pending: pending && (pending.selection ? { quote: pending.selection.quote } : {}),
    start,
    submit,
    cancel: useCallback(() => setPending(null), []),
    select,
    accept,
    editor,
  };
}

/**
 * A stored target as the note's editor counts it: positions start after the
 * heading the editor keeps as the title. A position inside that heading, or
 * one that cannot be lined up, is dropped and the quote finds the passage.
 */
function editorPosition(target: CommentTarget, leadPoints: number | undefined): CommentTarget {
  const position = target.text_position;
  if (!position || leadPoints === 0) return target;
  if (leadPoints === undefined || position.start < leadPoints) return { quote: target.quote };
  return { quote: target.quote, text_position: { ...position, start: position.start - leadPoints, end: position.end - leadPoints } };
}
