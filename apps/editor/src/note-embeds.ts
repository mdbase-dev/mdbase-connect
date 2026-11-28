import { t } from "@lingui/core/macro";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { LinkTargets } from "./collection-links";
import { internalLink } from "./links";
import type { MarkdownReference } from "./markdown-references";
import type { ParsedEmbeds } from "./code-editor-embed-positions";
import { markdownFragment } from "./markdown-fragments";
import type { CollectionFile, CollectionGateway, NoteDocument, NoteSummary } from "./model";
import { basename, notesByPath, noteTitle } from "./note";

export type ResolvedNoteEmbed = MarkdownReference & {
  key: string;
  status: "ready" | "loading" | "missing" | "ambiguous" | "missing_fragment" | "cycle" | "error";
  path?: string;
  title: string;
  body?: string;
  revision?: string;
  error?: string;
};

const EMPTY_REFERENCES: MarkdownReference[] = [];
const EMPTY_FILES: readonly CollectionFile[] = [];
const NO_TARGETS = { subscribe: () => () => undefined, getVersion: () => 0 };

export type EmbedCacheOwner = { collectionId: string | undefined; epoch: number };
type EmbedCacheStore = {
  gateway: Pick<CollectionGateway, "read">;
  collectionId: string | undefined;
  epoch: number;
  documents: Map<string, NoteDocument>;
  errors: Map<string, string>;
  pending: Map<string, Promise<void>>;
};

export function useEmbeddedNoteReferences(
  gateway: Pick<CollectionGateway, "read">,
  owner: EmbedCacheOwner,
  source: string,
  notes: readonly NoteSummary[],
  linkTargets: LinkTargets | undefined,
  visibleKeys?: ReadonlySet<string>,
  files: readonly CollectionFile[] = EMPTY_FILES
): ParsedEmbeds<ResolvedNoteEmbed> {
  const [cacheVersion, rerender] = useState(0);
  const targets = linkTargets ?? NO_TARGETS;
  const targetsVersion = useSyncExternalStore(targets.subscribe, targets.getVersion, targets.getVersion);
  const sourcePath = linkTargets?.from;
  const store = useMemo<EmbedCacheStore>(() => ({
    gateway, collectionId: owner.collectionId, epoch: owner.epoch,
    documents: new Map(), errors: new Map(), pending: new Map()
  }), [gateway, owner.collectionId, owner.epoch]);
  const activeStore = useRef<{ store: EmbedCacheStore } | undefined>(undefined);
  useEffect(() => {
    const activation = { store };
    const previous = activeStore.current;
    activeStore.current = activation;
    if (previous?.store !== store) clearStore(previous?.store);
    return () => {
      if (activeStore.current === activation) activeStore.current = undefined;
      clearStore(store);
    };
  }, [store]);
  const cache = store.documents;
  const errors = store.errors;

  const [parsed, setParsed] = useState<{ source: string; references: MarkdownReference[] }>(() => ({ source: "", references: EMPTY_REFERENCES }));
  // The last parse stands until the next one lands; the editor keeps its positions current meanwhile.
  const { references } = parsed;
  useEffect(() => {
    let active = true;
    void import("./markdown-references").then(({ markdownReferences }) => {
      if (active) setParsed({
        source,
        // An image from a URL embeds no note; the Editor does not load external images.
        references: markdownReferences(source).filter((reference) => (
          reference.kind === "embed" && reference.block && internalLink(reference.target)
        ))
      });
    });
    return () => { active = false; };
  }, [source]);

  useEffect(() => {
    const raws = references.filter((reference) => reference.target)
      .map((reference) => parsed.source.slice(reference.from, reference.to));
    // A failed lookup is shown on each embed through `linkTargets.failure`.
    if (raws.length) linkTargets?.resolveAll(raws).catch(() => undefined);
  }, [linkTargets, parsed.source, references]);

  const filePaths = useMemo(() => new Set(files.map((file) => file.path)), [files]);
  const resolved = useMemo(() => references.flatMap((reference): ResolvedNoteEmbed[] => {
    const key = `${reference.from}:${reference.to}`;
    const named = (reference.label ?? reference.target) || t`Missing note`;
    const target = reference.target
      ? linkTargets?.get(parsed.source.slice(reference.from, reference.to))
      : sourcePath ? { kind: "note" as const, path: sourcePath } : undefined;
    if (!target) {
      const failure = linkTargets?.failure;
      return [{ ...reference, key, status: failure ? "error" : "loading", title: named, ...(failure ? { error: failure } : {}) }];
    }
    if (target.kind === "file") return [];
    if (target.kind === "ambiguous") {
      const matches = target.candidates;
      const areFiles = matches.length > 0 && (filePaths.size > 0
        ? matches.every((path) => filePaths.has(path))
        : matches.every((path) => !notesByPath(notes).has(path) && !/\.md$/iu.test(path)));
      const examples = matches.slice(0, 3).join(", ");
      return [{
        ...reference,
        key,
        status: "ambiguous",
        title: reference.label ?? reference.target,
        error: areFiles
          ? t`${matches.length} files match “${reference.target}”. Use a full path to disambiguate: ${examples}.`
          : t`${matches.length} notes match this reference.`
      }];
    }
    if (target.kind !== "note") return [{ ...reference, key, status: "missing", title: named }];
    const path = target.path;
    const note = notesByPath(notes).get(path);
    const title = note ? noteTitle(note) : basename(path);
    if (path === sourcePath) {
      return [{ ...reference, key, status: "cycle", path, title }];
    }
    const cached = cache.get(path);
    const body = typeof note?.body === "string" ? note.body : cached?.body;
    const error = errors.get(path);
    if (body === undefined) {
      return [{
        ...reference,
        key,
        status: error ? "error" : "loading",
        path,
        title,
        ...(cached?.revision ? { revision: cached.revision } : {}),
        ...(error ? { error } : {})
      }];
    }
    const fragment = markdownFragment(body ?? "", reference.anchor);
    return [{
      ...reference,
      key,
      status: fragment === undefined ? "missing_fragment" : "ready",
      path,
      title: note ? noteTitle(note) : noteTitle(cached!),
      body: fragment,
      revision: cached?.revision
    }];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targetsVersion marks new answers in linkTargets
  }), [references, parsed.source, linkTargets, targetsVersion, sourcePath, notes, filePaths, store, cache, errors, cacheVersion]);

  const requests = resolved.filter((reference) => (
    reference.status === "loading"
    && reference.path
    && (!visibleKeys || visibleKeys.has(reference.key))
  ));
  const requestKey = requests.map((reference) => `${reference.path}:${reference.revision ?? ""}`).sort().join("\n");
  useEffect(() => {
    const activation = activeStore.current;
    if (!activation || activation.store !== store) return;
    for (const reference of requests) {
      const path = reference.path!;
      if (store.pending.has(path)) continue;
      const request = store.gateway.read(path).then((document) => {
        if (activeStore.current !== activation) return;
        store.documents.set(path, document);
        store.errors.delete(path);
        rerender((current) => current + 1);
      }).catch((error: unknown) => {
        if (activeStore.current !== activation) return;
        store.errors.set(
          path,
          error instanceof Error ? error.message : t`The transcluded note could not be opened.`
        );
        rerender((current) => current + 1);
      }).finally(() => {
        if (store.pending.get(path) === request) store.pending.delete(path);
      });
      store.pending.set(path, request);
    }
    // requestKey captures the stable set of visible revision-aware requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, requestKey]);

  return useMemo(() => ({ source: parsed.source, references: resolved }), [parsed.source, resolved]);
}

function clearStore(store: EmbedCacheStore | undefined): void {
  store?.documents.clear();
  store?.errors.clear();
  store?.pending.clear();
}
