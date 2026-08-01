import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import type { NoteDocument, TitleSource } from "./model";
import { editableNote } from "./note";

export type SaveState = "saved" | "waiting" | "saving" | "conflict";
export type NoteActivity = "saving" | "properties" | "renaming" | "moving" | "deleting" | "validating";

export interface Draft {
  title: string;
  body: string;
  source: TitleSource;
}

export interface NoteSession {
  editorSessionKey: string;
  document: NoteDocument;
  draft: Draft;
  persistedDraft: Draft;
  remoteDocument?: NoteDocument;
  saveState: SaveState;
  activity?: NoteActivity;
  activityDetail?: string;
  mutationController?: AbortController;
  mutationCancellable?: boolean;
  error?: string;
  deleted?: boolean;
  saveAgain?: boolean;
  savePromise?: Promise<void>;
}

let editorSessionSequence = 0;

export function createNoteSession(
  document: NoteDocument,
  types: CollectionTypeDescriptor[]
): NoteSession {
  const draft = editableNote(document, types);
  return {
    editorSessionKey: `note-editor-${++editorSessionSequence}`,
    document,
    draft,
    persistedDraft: structuredClone(draft),
    saveState: "saved"
  };
}

export function sessionDirty(session: NoteSession): boolean {
  return draftFingerprint(session.draft) !== draftFingerprint(session.persistedDraft);
}

function draftFingerprint(draft: Draft): string {
  return JSON.stringify([draft.title, draft.body, draft.source]);
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

  create(document: NoteDocument, types: CollectionTypeDescriptor[]): NoteSession {
    const session = createNoteSession(document, types);
    this.sessions.set(document.path, session);
    return session;
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
