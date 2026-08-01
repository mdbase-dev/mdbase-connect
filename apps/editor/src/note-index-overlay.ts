import type { NoteSummary } from "./model";

/**
 * Reconciles snapshot-backed collection reads with mutations already accepted by
 * the application. A body hydration request can legitimately finish against an
 * older snapshot after a local create, rename, update, or delete; those results
 * must not roll the visible index backwards.
 */
export class NoteIndexOverlay {
  private readonly upserts = new Map<string, NoteSummary>();
  private readonly removals = new Set<string>();

  upsert(note: NoteSummary, previousPath = note.path): void {
    if (previousPath !== note.path) {
      this.upserts.delete(previousPath);
      this.removals.add(previousPath);
    }
    this.removals.delete(note.path);
    this.upserts.set(note.path, note);
  }

  remove(path: string): void {
    this.upserts.delete(path);
    this.removals.add(path);
  }

  apply(notes: readonly NoteSummary[]): NoteSummary[] {
    const seen = new Set<string>();
    const reconciled: NoteSummary[] = [];

    for (const note of notes) {
      if (this.removals.has(note.path)) continue;
      const current = this.upserts.get(note.path) ?? note;
      reconciled.push(current);
      seen.add(current.path);
    }

    for (const note of this.upserts.values()) {
      if (!seen.has(note.path)) reconciled.unshift(note);
    }

    return reconciled;
  }

  clear(): void {
    this.upserts.clear();
    this.removals.clear();
  }
}
