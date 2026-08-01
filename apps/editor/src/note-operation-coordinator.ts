import type { NoteDocument, SaveNoteInput } from "./model";
import type { NoteSession } from "./note-session";
import { sessionDirty } from "./note-session";
import { KeyedOperationQueue } from "./operation-queue";

interface NoteOperationCoordinatorOptions {
  update(input: SaveNoteInput): Promise<NoteDocument>;
  onSaved(session: NoteSession, document: NoteDocument): void;
  onSaveError(session: NoteSession, error: unknown): void;
  onChange(session: NoteSession): void;
}

/** Serializes every write for a note and owns its autosave state transitions. */
export class NoteOperationCoordinator {
  private readonly queue = new KeyedOperationQueue<NoteSession>();

  constructor(private readonly options: NoteOperationCoordinatorOptions) {}

  requestSave(session: NoteSession): Promise<void> {
    if (session.deleted) return Promise.resolve();
    if (session.remoteDocument) {
      session.saveState = "conflict";
      this.options.onChange(session);
      return Promise.resolve();
    }
    if (session.savePromise) {
      if (sessionDirty(session)) session.saveAgain = true;
      return session.savePromise;
    }
    if (!sessionDirty(session)) {
      session.saveState = "saved";
      this.options.onChange(session);
      return Promise.resolve();
    }

    const promise = this.queue.run(session, async () => {
      do {
        session.saveAgain = false;
        if (!sessionDirty(session) || session.deleted) break;
        const snapshot = structuredClone(session.draft);
        session.activity = "saving";
        session.saveState = "saving";
        this.options.onChange(session);
        try {
          const document = await this.options.update({
            path: session.document.path,
            revision: session.document.revision,
            frontmatter: session.document.frontmatter,
            ...snapshot
          });
          session.document = document;
          session.persistedDraft = snapshot;
          session.error = undefined;
          session.saveState = sessionDirty(session) ? "waiting" : "saved";
          this.options.onSaved(session, document);
          this.options.onChange(session);
        } catch (error) {
          session.saveState = "conflict";
          session.activity = undefined;
          this.options.onSaveError(session, error);
          this.options.onChange(session);
          throw error;
        }
      } while (session.saveAgain && sessionDirty(session));
      session.activity = undefined;
      session.saveState = sessionDirty(session) ? "waiting" : "saved";
      this.options.onChange(session);
    });

    session.savePromise = promise;
    const finish = () => {
      if (session.savePromise === promise) session.savePromise = undefined;
      this.options.onChange(session);
    };
    void promise.then(finish, finish);
    return promise;
  }

  async flush(session: NoteSession): Promise<void> {
    if (session.remoteDocument) throw new Error("Resolve the version changed elsewhere before continuing.");
    while (!session.deleted && !session.remoteDocument && (sessionDirty(session) || session.savePromise)) {
      await this.requestSave(session);
    }
    await this.queue.wait(session);
  }

  run<Result>(session: NoteSession, operation: () => Promise<Result>): Promise<Result> {
    return this.queue.run(session, operation);
  }

  wait(session: NoteSession): Promise<void> {
    return this.queue.wait(session);
  }

  waitForIdle(): Promise<void> {
    return this.queue.waitForIdle();
  }

  get pendingCount(): number {
    return this.queue.pendingCount;
  }
}
