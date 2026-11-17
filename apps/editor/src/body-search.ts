import type { CollectionGateway, NoteSummary } from "./model";
import { parseSearchQuery } from "./search-query";

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
/** The runtime query for notes with `tag` or a tag nested under it, among
 * frontmatter `tags` and inline `#tags` in the text: the collection's own
 * `file.hasTag`, so the page never reads tags out of Markdown itself. */
export function tagSearchWhere(tag: string): string {
  return `file.hasTag(${JSON.stringify(tag)})`;
}

export function bodySearchTerm(word: string): string | undefined {
  const term = word.toLowerCase();
  return [...term].length >= MIN_TERM_LENGTH ? term : undefined;
}

export function bodySearchTerms(query: string): string[] {
  return [...new Set(parseSearchQuery(query).words.flatMap((word) => bodySearchTerm(word) ?? []))];
}

export interface BodySearchSnapshot {
  /** Some term or tag of the current search has no answer yet. */
  pending: boolean;
  error?: unknown;
  /** Advances whenever an answer or an excerpt arrives. */
  version: number;
}

/** Body matches and tag filters for the note list's search, asked of the
 * collection's runtime rather than read from every note's text in the page.
 * A term or tag is asked once typing pauses; an answer from before a record
 * change stays shown while it is asked again. */
export class BodySearch {
  /** The questions of the current search: `b:<term>` for a body term,
   * `t:<tag>` for a tag filter. */
  private keys: string[] = [];
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
    private readonly gateway: Pick<CollectionGateway, "searchBodies" | "searchTag" | "read">,
    private readonly delayMs = ASK_DELAY_MS
  ) {}

  getSnapshot = (): BodySearchSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** The paths whose text contains `term`, or undefined until answered. */
  paths(term: string): ReadonlySet<string> | undefined {
    return this.answers.get(`b:${term}`)?.paths;
  }

  /** The paths of notes with `tag` (or a tag nested under it), or undefined until answered. */
  tagged(tag: string): ReadonlySet<string> | undefined {
    return this.answers.get(`t:${tag}`)?.paths;
  }

  /** The note's text, when it was read for an excerpt at its listed revision. */
  text(note: NoteSummary): string | undefined {
    const read = this.texts.get(note.path);
    return read && read.revision === note.revision ? read.body : undefined;
  }

  /** Search for body `terms` and `tags` at index `revision`. */
  search(terms: readonly string[], tags: readonly string[], revision: number): void {
    const keys = [...new Set([...terms.map((term) => `b:${term}`), ...tags.map((tag) => `t:${tag}`)])];
    this.keys = keys;
    this.revision = revision;
    for (const key of this.answers.keys()) if (!keys.includes(key)) this.answers.delete(key);
    for (const [key, controller] of this.running) {
      if (!keys.includes(key)) {
        controller.abort();
        this.running.delete(key);
      }
    }
    this.schedule();
    this.publish();
  }

  retry(): void {
    this.snapshot = { ...this.snapshot, error: undefined };
    for (const key of this.keys) this.ask(key);
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
    this.keys = [];
    this.snapshot = { pending: false, version: this.snapshot.version };
    this.publish(true);
  }

  private stale(key: string): boolean {
    return this.answers.get(key)?.revision !== this.revision;
  }

  /** Ask every stale question once typing (or editing) pauses. */
  private schedule(): void {
    clearTimeout(this.timer);
    if (this.snapshot.error !== undefined || !this.keys.some((key) => this.stale(key) && !this.running.has(key))) return;
    this.timer = setTimeout(() => {
      for (const key of this.keys) this.ask(key);
    }, this.delayMs);
  }

  private ask(key: string): void {
    if (!this.stale(key) || this.running.has(key)) return;
    const controller = new AbortController();
    const revision = this.revision;
    this.running.set(key, controller);
    const value = key.slice(2);
    const answer = key.startsWith("t:")
      ? this.gateway.searchTag(value, { signal: controller.signal })
      : this.gateway.searchBodies(value, { signal: controller.signal });
    void answer.then((paths) => {
      if (controller.signal.aborted) return;
      this.running.delete(key);
      this.answers.set(key, { revision, paths: new Set(paths) });
      this.publish(true);
      // Records changed while it ran: ask again.
      this.schedule();
    }, (error: unknown) => {
      if (controller.signal.aborted) return;
      this.running.delete(key);
      for (const other of this.running.values()) other.abort();
      this.running.clear();
      this.snapshot = { ...this.snapshot, error };
      this.publish(true);
    });
  }

  private publish(changed = false): void {
    const pending = this.snapshot.error === undefined && this.keys.some((key) => !this.answers.has(key));
    if (!changed && pending === this.snapshot.pending) return;
    this.snapshot = { ...this.snapshot, pending, version: this.snapshot.version + (changed ? 1 : 0) };
    for (const listener of this.listeners) listener();
  }
}
