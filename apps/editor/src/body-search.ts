import type { CollectionGateway, NoteSummary } from "./model";

/** Shorter terms match too much of any body to be worth a query, and the
 * runtime's index answers only terms of three or more characters. */
const MIN_TERM_LENGTH = 3;
/** Bodies read for result excerpts, at most this many per search. */
export const EXCERPT_READS = 24;
/** Excerpt texts kept, oldest dropped first. */
const KEPT_TEXTS = 200;
/** Typing pause before a term is asked, so each keystroke is not a query. */
const ASK_DELAY_MS = 150;

/** The runtime query for notes whose text contains `term`. A JSON string is
 * a valid CEL string literal. */
export function bodySearchWhere(term: string): string {
  return `file.body.lower().contains(${JSON.stringify(term)})`;
}

/** The body terms of a search as typed: each word lower-cased, without the
 * accent folding titles and paths get (the runtime matches text exactly). */
export function bodySearchTerm(word: string): string | undefined {
  const term = word.toLowerCase();
  return [...term].length >= MIN_TERM_LENGTH ? term : undefined;
}

export function bodySearchTerms(query: string): string[] {
  return [...new Set(query.trim().split(/\s+/).flatMap((word) => bodySearchTerm(word) ?? []))];
}

export interface BodySearchSnapshot {
  /** Some term of the current search has no answer yet. */
  pending: boolean;
  error?: unknown;
  /** Advances whenever an answer or an excerpt arrives. */
  version: number;
}

/** Body matches for the note list's search, asked of the collection's
 * runtime rather than read from every note's text in the page. A term is
 * asked once typing pauses; an answer from before a record change stays
 * shown while the term is asked again. */
export class BodySearch {
  private terms: string[] = [];
  private revision = 0;
  private answers = new Map<string, { revision: number; paths: ReadonlySet<string> }>();
  private running = new Map<string, AbortController>();
  private timer?: ReturnType<typeof setTimeout>;
  private texts = new Map<string, { revision: string | undefined; body: string }>();
  private reading = new Set<string>();
  /** Advances on reset, so a read begun for an earlier collection is dropped. */
  private generation = 0;
  private snapshot: BodySearchSnapshot = { pending: false, version: 0 };
  private listeners = new Set<() => void>();

  constructor(
    private readonly gateway: Pick<CollectionGateway, "searchBodies" | "read">,
    private readonly delayMs = ASK_DELAY_MS
  ) {}

  getSnapshot = (): BodySearchSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** The paths whose text contains `term`, or undefined until answered. */
  paths(term: string): ReadonlySet<string> | undefined {
    return this.answers.get(term)?.paths;
  }

  /** The note's text, when it was read for an excerpt at its listed revision. */
  text(note: NoteSummary): string | undefined {
    const read = this.texts.get(note.path);
    return read && read.revision === note.revision ? read.body : undefined;
  }

  /** Search for `terms` at index `revision`. */
  search(terms: string[], revision: number): void {
    this.terms = terms;
    this.revision = revision;
    for (const term of this.answers.keys()) if (!terms.includes(term)) this.answers.delete(term);
    for (const [term, controller] of this.running) {
      if (!terms.includes(term)) {
        controller.abort();
        this.running.delete(term);
      }
    }
    this.schedule();
    this.publish();
  }

  retry(): void {
    this.snapshot = { ...this.snapshot, error: undefined };
    for (const term of this.terms) this.ask(term);
    this.publish(true);
  }

  /** Read the text of matched notes the page does not hold, for their excerpts. */
  readTexts(notes: readonly NoteSummary[]): void {
    for (const note of notes.slice(0, EXCERPT_READS)) {
      if (note.body !== undefined || this.text(note) !== undefined || this.reading.has(note.path)) continue;
      this.reading.add(note.path);
      const generation = this.generation;
      void this.gateway.read(note.path).then((document) => {
        if (generation !== this.generation) return;
        this.texts.delete(note.path);
        // Kept against the listed revision it was read for: a later change to the note retires it.
        this.texts.set(note.path, { revision: note.revision, body: document.body ?? "" });
        if (this.texts.size > KEPT_TEXTS) this.texts.delete(this.texts.keys().next().value!);
        this.publish(true);
      }, () => undefined).finally(() => { if (generation === this.generation) this.reading.delete(note.path); });
    }
  }

  reset(): void {
    clearTimeout(this.timer);
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
    this.answers.clear();
    this.texts.clear();
    this.reading.clear();
    this.generation += 1;
    this.terms = [];
    this.snapshot = { pending: false, version: this.snapshot.version };
    this.publish(true);
  }

  private stale(term: string): boolean {
    return this.answers.get(term)?.revision !== this.revision;
  }

  /** Ask for every stale term once typing (or editing) pauses. */
  private schedule(): void {
    clearTimeout(this.timer);
    if (this.snapshot.error !== undefined || !this.terms.some((term) => this.stale(term) && !this.running.has(term))) return;
    this.timer = setTimeout(() => {
      for (const term of this.terms) this.ask(term);
    }, this.delayMs);
  }

  private ask(term: string): void {
    if (!this.stale(term) || this.running.has(term)) return;
    const controller = new AbortController();
    const revision = this.revision;
    this.running.set(term, controller);
    void this.gateway.searchBodies(term, { signal: controller.signal }).then((paths) => {
      if (controller.signal.aborted) return;
      this.running.delete(term);
      this.answers.set(term, { revision, paths: new Set(paths) });
      this.publish(true);
      // Records changed while it ran: ask again.
      this.schedule();
    }, (error: unknown) => {
      if (controller.signal.aborted) return;
      this.running.delete(term);
      for (const other of this.running.values()) other.abort();
      this.running.clear();
      this.snapshot = { ...this.snapshot, error };
      this.publish(true);
    });
  }

  private publish(changed = false): void {
    const pending = this.snapshot.error === undefined && this.terms.some((term) => !this.answers.has(term));
    if (!changed && pending === this.snapshot.pending) return;
    this.snapshot = { ...this.snapshot, pending, version: this.snapshot.version + (changed ? 1 : 0) };
    for (const listener of this.listeners) listener();
  }
}
