import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { RecordSession, type RecordSessionAdapter } from "@mdbase-dev/connect/advanced";
import type { CollectionGateway, NoteDocument, TitleSource } from "./model";
import { editableNote, persistedBody, titlePatch } from "./note";

export type SaveState = "saved" | "waiting" | "saving" | "conflict" | "recovery" | "error";
export type NoteActivity = "saving" | "properties" | "renaming" | "moving" | "deleting" | "validating";

export interface Draft {
  title: string;
  body: string;
  source: TitleSource;
}

export const AUTOSAVE_IDLE_MS = 650;

let editorSessionSequence = 0;

/**
 * The editor's view of one open note. The SDK record session owns the write
 * queue, revision checks, conflicts and recovery; the note session projects
 * its Markdown into the editor's title/body draft and back.
 */
export class NoteSession {
  readonly editorSessionKey = `note-editor-${++editorSessionSequence}`;
  readonly record: RecordSession<NoteDocument>;
  draft: Draft;
  activity?: NoteActivity;
  activityDetail?: string;
  mutationController?: AbortController;
  mutationCancellable?: boolean;
  error?: string;
  /** Staged tombstone: set when deletion starts, cleared if it fails. */
  deleted?: boolean;

  constructor(
    document: NoteDocument,
    private readonly types: () => CollectionTypeDescriptor[],
    adapter: RecordSessionAdapter<NoteDocument>
  ) {
    this.record = new RecordSession(document, adapter, { autosave: { idleMs: AUTOSAVE_IDLE_MS } });
    this.draft = editableNote(document, types());
  }

  get document(): NoteDocument {
    return this.record.snapshot.record;
  }

  get remoteDocument(): NoteDocument | undefined {
    return this.record.snapshot.remote ?? undefined;
  }

  get pendingRequestId(): string | undefined {
    return this.record.snapshot.pendingRequestId;
  }

  get saveState(): SaveState {
    const { state } = this.record.snapshot;
    return state === "unsaved" ? "waiting" : state === "deleted" ? "saved" : state;
  }

  edit(draft: Draft): void {
    this.draft = draft;
    this.record.setBody(persistedBody(draft.title, draft.body, draft.source));
    const patch = titlePatch(draft.title, draft.source, this.record.snapshot.frontmatter);
    if (!this.projects(this.draft)) this.record.patchFrontmatter(patch);
  }

  /**
   * Re-derive the draft when the record session replaced the text itself
   * (an adopted remote version, "Use latest", discard). Returns whether it did.
   */
  reproject(): boolean {
    if (this.projects(this.draft)) return false;
    const snapshot = this.record.snapshot;
    this.draft = editableNote({ ...snapshot.record, body: snapshot.body, frontmatter: snapshot.frontmatter }, this.types());
    return true;
  }

  /** Whether the draft's Markdown and title field match the record session's text. */
  private projects(draft: Draft): boolean {
    const snapshot = this.record.snapshot;
    if (persistedBody(draft.title, draft.body, draft.source) !== snapshot.body) return false;
    return Object.entries(titlePatch(draft.title, draft.source, snapshot.frontmatter))
      .every(([key, value]) => JSON.stringify(snapshot.frontmatter[key]) === JSON.stringify(value));
  }
}

/** Note records through the collection gateway. `guard` wraps each write or recovery. */
export function noteRecordAdapter(
  gateway: Pick<CollectionGateway, "update" | "read" | "recoverNoteMutation" | "pendingNoteMutations">,
  guard: <Result>(operation: () => Promise<Result>) => Promise<Result> = (operation) => operation()
): RecordSessionAdapter<NoteDocument> {
  return {
    revision: (note) => note.revision,
    body: (note) => note.body ?? "",
    frontmatter: (note) => note.frontmatter,
    write: (base, change) => guard(() => gateway.update(base, change)),
    read: (base) => gateway.read(base.path),
    recover: (requestId) => guard(() => gateway.recoverNoteMutation(requestId)),
    isPending: (requestId) => gateway.pendingNoteMutations().some((pending) => pending.requestId === requestId)
  };
}

export function sessionDirty(session: NoteSession): boolean {
  return session.record.snapshot.dirty;
}

/** Owns note-session identity and path changes independently of React renders. */
export class NoteSessionStore {
  private readonly sessions = new Map<string, NoteSession>();
  active?: NoteSession;

  get(path: string): NoteSession | undefined {
    return this.sessions.get(path);
  }

  has(path: string): boolean {
    return this.sessions.has(path);
  }

  set(path: string, session: NoteSession): void {
    this.sessions.set(path, session);
  }

  activate(session: NoteSession): void {
    this.active = session;
  }

  deactivate(session?: NoteSession): void {
    if (!session || this.active === session) this.active = undefined;
  }

  move(from: string, to: string, session: NoteSession): void {
    if (this.sessions.get(from) === session) this.sessions.delete(from);
    this.sessions.set(to, session);
  }

  delete(path: string): boolean {
    const session = this.sessions.get(path);
    if (session && this.active === session) this.active = undefined;
    return this.sessions.delete(path);
  }

  values(): IterableIterator<NoteSession> {
    return this.sessions.values();
  }

  clear(): void {
    this.active = undefined;
    this.sessions.clear();
  }
}
