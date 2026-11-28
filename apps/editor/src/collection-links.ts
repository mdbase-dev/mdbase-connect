/** The collection's answers about links: which notes link to the open note,
 * and where the links written in it lead. The editor resolves nothing itself. */
import { useLingui } from "@lingui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CollectionTypeDescriptor } from "./connect-types";
import { gatewayError } from "./gateway";
import { collectionDisplayField } from "./field-reference";
import type { Backlink, CollectionFile, CollectionGateway, LinkTarget, NoteSummary } from "./model";
import { notesByPath, noteTitle } from "./note";
import { internalLink } from "./links";

/** A listed note that links to the open one. */
export interface LinkingNote {
  note: NoteSummary;
  /** The properties its links are written in; none when they are all in its text. */
  fields: string[];
}

export interface Backlinks {
  /** Listed referring notes, by title. A path not yet listed appears once it is. */
  notes: LinkingNote[];
  loading: boolean;
  error?: string;
  retry(): void;
}

/** Linking notes of one type, for a "Linked from" grouped the way a person
 * thinks of them: the books by this author, the meetings with this person. */
export interface BacklinkGroup {
  /** The type's name; absent for notes without a declared type. */
  type?: string;
  icon?: string;
  notes: LinkingNote[];
}

/** Linking notes by the first declared type of each, types in name order and
 * untyped notes last. A note with several types is listed once. */
export function backlinkGroups(notes: readonly LinkingNote[], types: readonly CollectionTypeDescriptor[]): BacklinkGroup[] {
  const declared = new Map(types.map((type) => [type.name.toLocaleLowerCase(), type]));
  const groups = new Map<string, BacklinkGroup>();
  for (const linking of notes) {
    const type = linking.note.types.map((name) => declared.get(name.toLocaleLowerCase())).find(Boolean);
    const key = type?.name ?? "";
    const group = groups.get(key) ?? { ...(type ? { type: type.name } : {}), icon: collectionDisplayField(type, "icon"), notes: [] };
    group.notes.push(linking);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) =>
    Number(!left.type) - Number(!right.type) || (left.type ?? "").localeCompare(right.type ?? ""));
}

const EMPTY_LINKS: Backlink[] = [];

interface Loaded { path?: string; links: Backlink[]; loading: boolean; error?: string }

/** The replica's backlinks for the open note, refetched when records change.
 * Resolution is the collection's own; the editor does not scan for links. */
export function useBacklinks(gateway: CollectionGateway, path: string | undefined, revision: number,
  listed: NoteSummary[], types: CollectionTypeDescriptor[]): Backlinks {
  const { i18n } = useLingui();
  const [loaded, setLoaded] = useState<Loaded>({ links: EMPTY_LINKS, loading: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!path) {
      setLoaded(current => current.path ? { links: EMPTY_LINKS, loading: false } : current);
      return;
    }
    const controller = new AbortController();
    // Keep the previous answer for the same note visible while it refreshes.
    setLoaded(current => ({ path, links: current.path === path ? current.links : EMPTY_LINKS, loading: true }));
    gateway.backlinks(path, { signal: controller.signal }).then(
      links => { if (!controller.signal.aborted) setLoaded({ path, links, loading: false }); },
      (error: unknown) => { if (!controller.signal.aborted) setLoaded({ path, links: [], loading: false, error: gatewayError(error) }); }
    );
    return () => controller.abort();
  }, [gateway, path, revision, attempt]);
  const retry = useCallback(() => setAttempt(n => n + 1), []);
  const current = loaded.path === path;
  const links = current ? loaded.links : EMPTY_LINKS;
  const notes = useMemo(() => {
    if (!links.length) return [];
    const byPath = notesByPath(listed);
    return links.flatMap(({ path, fields }) => {
      const note = byPath.get(path);
      return note ? [{ note, fields, title: noteTitle(note, types) }] : [];
    }).sort((a, b) => a.title.localeCompare(b.title) || a.note.path.localeCompare(b.note.path));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- titles follow the locale
  }, [listed, links, types, i18n.locale]);
  return { notes, loading: Boolean(path) && (!current || loaded.loading), error: current ? loaded.error : undefined, retry };
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

  constructor(
    private readonly gateway: Pick<CollectionGateway, "resolveLinks">,
    readonly from: string,
    previous?: LinkTargets,
    private readonly files: readonly CollectionFile[] = []
  ) {
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
    const waits = new Set<Promise<void>>();
    const wanted: string[] = [];
    for (const raw of new Set(raws)) {
      const pending = this.pending.get(raw);
      if (pending) waits.add(pending);
      else if (!this.confirmed.has(raw)) wanted.push(raw);
    }
    if (wanted.length) {
      const request = this.resolveWithRootedFiles(wanted).then(targets => {
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
      waits.add(request);
    }
    return waits.size ? Promise.all(waits).then(() => undefined) : Promise.resolve();
  }

  /** Compatibility for attachments linked by Editor builds before 2026-11,
   * which wrote Markdown destinations from the collection root without a
   * leading slash. The collection reads them from the note's folder; a missing
   * one is asked again as rooted and kept only if that names a file. Remove
   * once those notes are rewritten. */
  private async resolveWithRootedFiles(raws: string[]): Promise<LinkTarget[]> {
    const targets = [...await this.gateway.resolveLinks(this.from, raws)];
    const retry = raws.flatMap((raw, index) => {
      const rooted = targets[index]!.kind === "missing" ? rootedMarkdownLink(raw) : undefined;
      return rooted ? [{ index, rooted }] : [];
    });
    if (retry.length) {
      const again = await this.gateway.resolveLinks(this.from, retry.map(({ rooted }) => rooted));
      retry.forEach(({ index }, position) => {
        if (again[position]!.kind === "file") targets[index] = again[position]!;
      });
    }
    if (this.files.length) {
      raws.forEach((raw, index) => {
        if (targets[index]!.kind !== "missing") return;
        const matched = resolveFileEmbedBasename(raw, this.files);
        if (matched) targets[index] = matched;
      });
    }
    return targets;
  }

  async resolve(raw: string): Promise<LinkTarget> {
    await this.resolveAll([raw]);
    return this.targets.get(raw)!;
  }
}

/** The open note's link answers, renewed when records or files change: an
 * upload can turn a missing link into a file. */
export function useLinkTargets(gateway: CollectionGateway, path: string | undefined, revision: number,
  files: readonly CollectionFile[]): LinkTargets | undefined {
  const previous = useRef<LinkTargets>(undefined);
  return useMemo(() => path ? (previous.current = new LinkTargets(gateway, path, previous.current, files)) : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new revision or file list asks again
    [gateway, path, revision, files]);
}

/** `raw`, a Markdown link with a folder-relative destination, with that
 * destination read from the collection root instead. */
function rootedMarkdownLink(raw: string): string | undefined {
  const link = /^(!?\[[^\]]*\]\(<?)([^)>]*)/.exec(raw);
  const target = link?.[2];
  if (!link || !target || /^(?:\/|\.\.?\/)/.test(target) || !internalLink(target)) return undefined;
  return `${link[1]}/${raw.slice(link[1].length)}`;
}

/** Resolve a bare wikilink file embed (`![[page.html]]`) by unique basename
 * when the collection did not match a note or explicit path. */
function resolveFileEmbedBasename(raw: string, files: readonly CollectionFile[]): LinkTarget | undefined {
  const embed = /^!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/.exec(raw);
  const target = embed?.[1]?.trim();
  if (!target || target.includes("/") || target.startsWith(".") || !internalLink(target)) return undefined;
  const wanted = target.normalize("NFC").toLocaleLowerCase();
  const matches = files
    .filter((file) => {
      const name = file.path.split("/").at(-1) ?? file.path;
      return name.normalize("NFC").toLocaleLowerCase() === wanted;
    })
    .map((file) => file.path)
    .sort((left, right) => left.localeCompare(right));
  if (matches.length === 1) return { kind: "file", path: matches[0]! };
  if (matches.length > 1) return { kind: "ambiguous", candidates: matches };
  return undefined;
}
