/** The collection's answers about links: which notes link to the open note,
 * and where the links written in it lead. The editor resolves nothing itself. */
import { useLingui } from "@lingui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { gatewayError } from "./gateway";
import type { CollectionGateway, LinkTarget, NoteSummary } from "./model";
import { noteTitle } from "./note";

export interface Backlinks {
  /** Listed referring notes, by title. A path not yet listed appears once it is. */
  notes: NoteSummary[];
  loading: boolean;
  error?: string;
  retry(): void;
}

interface Loaded { path?: string; paths: string[]; loading: boolean; error?: string }

/** The replica's backlinks for the open note, refetched when records change.
 * Resolution is the collection's own; the editor does not scan for links. */
export function useBacklinks(gateway: CollectionGateway, path: string | undefined, revision: number,
  listed: NoteSummary[], types: CollectionTypeDescriptor[]): Backlinks {
  const { i18n } = useLingui();
  const [loaded, setLoaded] = useState<Loaded>({ paths: [], loading: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!path) {
      setLoaded({ paths: [], loading: false });
      return;
    }
    const controller = new AbortController();
    // Keep the previous answer for the same note visible while it refreshes.
    setLoaded(current => ({ path, paths: current.path === path ? current.paths : [], loading: true }));
    gateway.backlinks(path, { signal: controller.signal }).then(
      paths => { if (!controller.signal.aborted) setLoaded({ path, paths, loading: false }); },
      (error: unknown) => { if (!controller.signal.aborted) setLoaded({ path, paths: [], loading: false, error: gatewayError(error) }); }
    );
    return () => controller.abort();
  }, [gateway, path, revision, attempt]);
  const retry = useCallback(() => setAttempt(n => n + 1), []);
  const current = loaded.path === path;
  const paths = current ? loaded.paths : [];
  const notes = useMemo(() => {
    const byPath = new Map(listed.map(note => [note.path, note]));
    return paths.flatMap(path => byPath.get(path) ?? [])
      .sort((a, b) => noteTitle(a, types).localeCompare(noteTitle(b, types)) || a.path.localeCompare(b.path));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- titles follow the locale
  }, [listed, paths, types, i18n.locale]);
  return { notes, loading: loaded.loading, error: current ? loaded.error : undefined, retry };
}

/** Where the links written in one note lead, resolved by the collection in
 * batches and keyed by the link as written. One instance serves one note at one
 * collection revision; it starts from the previous instance's answers so a
 * change elsewhere does not blank embeds while they are confirmed again. */
export class LinkTargets {
  private readonly targets: Map<string, LinkTarget>;
  private readonly confirmed = new Set<string>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  failure?: string;

  constructor(private readonly gateway: Pick<CollectionGateway, "resolveLinks">, readonly from: string, previous?: LinkTargets) {
    this.targets = new Map(previous?.from === from ? previous.targets : []);
  }

  get(raw: string): LinkTarget | undefined { return this.targets.get(raw); }
  getVersion = (): number => this.version;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Resolve every link not yet confirmed at this revision, in one request. */
  resolveAll(raws: Iterable<string>): Promise<void> {
    const waits: Promise<void>[] = [];
    const wanted: string[] = [];
    for (const raw of new Set(raws)) {
      const pending = this.pending.get(raw);
      if (pending) waits.push(pending);
      else if (!this.confirmed.has(raw)) wanted.push(raw);
    }
    if (wanted.length) {
      const request = this.gateway.resolveLinks(this.from, wanted).then(targets => {
        wanted.forEach((raw, index) => { this.targets.set(raw, targets[index]!); this.confirmed.add(raw); });
        this.failure = undefined;
      }, (error: unknown) => {
        this.failure = gatewayError(error);
        throw error;
      }).finally(() => {
        for (const raw of wanted) this.pending.delete(raw);
        this.version += 1;
        for (const listener of this.listeners) listener();
      });
      for (const raw of wanted) this.pending.set(raw, request);
      waits.push(request);
    }
    return Promise.all(waits).then(() => undefined);
  }

  async resolve(raw: string): Promise<LinkTarget> {
    await this.resolveAll([raw]);
    return this.targets.get(raw)!;
  }
}

/** The open note's link answers, renewed when records change. */
export function useLinkTargets(gateway: CollectionGateway, path: string | undefined, revision: number): LinkTargets | undefined {
  const previous = useRef<LinkTargets>(undefined);
  return useMemo(() => path ? (previous.current = new LinkTargets(gateway, path, previous.current)) : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new revision asks again
    [gateway, path, revision]);
}

/** Links an editor can ask the collection about: not external URLs. */
export function internalLink(target: string): boolean {
  return !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target);
}
