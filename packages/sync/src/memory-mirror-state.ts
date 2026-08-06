import { SyncError } from "./sync-error.js";
import type { MirrorState, MirrorStateStore } from "./mirror-state.js";
import { applySyncJournalEvent, type SyncJournalEvent } from "./sync-journal.js";

/** In-process durable-state model with the same append-only replay contract. */
export class MemoryMirrorStateStore implements MirrorStateStore {
  private state: MirrorState | null = null;

  async read(): Promise<MirrorState | null> {
    return this.state === null ? null : structuredClone(this.state);
  }

  async write(state: MirrorState): Promise<void> {
    this.state = structuredClone(state);
  }

  async appendJournal(event: SyncJournalEvent): Promise<void> {
    if (!this.state) throw new SyncError("invalid_mirror_state", "Mirror journal has no base state.");
    applySyncJournalEvent(this.state, structuredClone(event));
  }
}
