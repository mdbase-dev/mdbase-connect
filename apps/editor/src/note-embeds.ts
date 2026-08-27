import { useEffect, useRef, useState } from "react";
import { resolveFileReference } from "./file-reference-resolution";
import { resolveLinkSuggestionMatches, type LinkSuggestion } from "./links";
import type { MarkdownReference } from "./markdown-references";
import { markdownFragment } from "./markdown-fragments";
import type { CollectionFile, CollectionGateway, NoteDocument, NoteSummary } from "./model";
import { noteTitle } from "./note";

export type ResolvedNoteEmbed = MarkdownReference & {
  key: string;
  status: "ready" | "loading" | "missing" | "ambiguous" | "missing_fragment" | "cycle" | "error";
  path?: string;
  title: string;
  body?: string;
  revision?: string;
  error?: string;
};

type EmbedCacheOwner = { collectionId: string | undefined; epoch: number };
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
  suggestions: LinkSuggestion[],
  files: readonly CollectionFile[],
  sourcePath?: string,
  visibleKeys?: ReadonlySet<string>
): ResolvedNoteEmbed[] {
  const [, rerender] = useState(0);
  const activeStore = useRef<EmbedCacheStore | undefined>(undefined);
  let store = activeStore.current;
  if (!store || store.gateway !== gateway || store.collectionId !== owner.collectionId || store.epoch !== owner.epoch) {
    store = {
      gateway, collectionId: owner.collectionId, epoch: owner.epoch,
      documents: new Map(), errors: new Map(), pending: new Map()
    };
    activeStore.current = store;
  }
  const cache = store.documents;
  const errors = store.errors;

  const [parsed, setParsed] = useState<{ source: string; references: MarkdownReference[] }>(() => ({ source: "", references: [] }));
  const references = parsed.source === source ? parsed.references : [];
  useEffect(() => {
    let active = true;
    void import("./markdown-references").then(({ markdownReferences }) => {
      if (active) setParsed({
        source,
        references: markdownReferences(source).filter((reference) => (
          reference.kind === "embed" && reference.block
        ))
      });
    });
    return () => { active = false; };
  }, [source]);

  const resolved = references.flatMap((reference): ResolvedNoteEmbed[] => {
    const key = `${reference.from}:${reference.to}`;
    const matches = reference.target
      ? resolveLinkSuggestionMatches(reference.target, suggestions, sourcePath, reference.format)
      : suggestions.filter((candidate) => candidate.path === sourcePath);
    if (matches.length > 1) {
      return [{
        ...reference,
        key,
        status: "ambiguous",
        title: reference.label ?? reference.target,
        error: `${matches.length} notes match this reference.`
      }];
    }
    const suggestion = matches[0];
    if (!suggestion) {
      if (reference.target && resolveFileReference(reference.target, reference.format, files, sourcePath)) return [];
      return [{ ...reference, key, status: "missing", title: (reference.label ?? reference.target) || "Missing note" }];
    }
    const path = suggestion.path;
    if (path === sourcePath) {
      return [{ ...reference, key, status: "cycle", path, title: suggestion.title }];
    }
    const note = notes.find((candidate) => candidate.path === path);
    const cached = cache.get(path);
    const body = typeof note?.body === "string" ? note.body : cached?.body;
    const error = errors.get(path);
    if (body === undefined) {
      return [{
        ...reference,
        key,
        status: error ? "error" : "loading",
        path,
        title: suggestion.title,
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
  });

  const requests = resolved.filter((reference) => (
    reference.status === "loading"
    && reference.path
    && (!visibleKeys || visibleKeys.has(reference.key))
  ));
  const requestKey = requests.map((reference) => `${reference.path}:${reference.revision ?? ""}`).sort().join("\n");
  useEffect(() => {
    for (const reference of requests) {
      const path = reference.path!;
      if (store.pending.has(path)) continue;
      const capturedStore = store;
      const request = gateway.read(path).then((document) => {
        if (activeStore.current !== capturedStore) return;
        capturedStore.documents.set(path, document);
        capturedStore.errors.delete(path);
        rerender((current) => current + 1);
      }).catch((error: unknown) => {
        if (activeStore.current !== capturedStore) return;
        capturedStore.errors.set(
          path,
          error instanceof Error ? error.message : "The transcluded note could not be opened."
        );
        rerender((current) => current + 1);
      }).finally(() => {
        if (capturedStore.pending.get(path) === request) capturedStore.pending.delete(path);
      });
      capturedStore.pending.set(path, request);
    }
    // requestKey captures the stable set of visible revision-aware requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, owner.collectionId, owner.epoch, requestKey]);

  return resolved;
}
