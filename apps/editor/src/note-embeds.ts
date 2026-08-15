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

export function useEmbeddedNoteReferences(
  gateway: Pick<CollectionGateway, "read">,
  source: string,
  notes: readonly NoteSummary[],
  suggestions: LinkSuggestion[],
  files: readonly CollectionFile[],
  sourcePath?: string,
  visibleKeys?: ReadonlySet<string>
): ResolvedNoteEmbed[] {
  const [cache, setCache] = useState(() => new Map<string, NoteDocument>());
  const [errors, setErrors] = useState(() => new Map<string, string>());
  const pending = useRef(new Map<string, Promise<void>>());
  const gatewayRef = useRef(gateway);
  gatewayRef.current = gateway;

  useEffect(() => {
    pending.current.clear();
    setCache(new Map());
    setErrors(new Map());
  }, [gateway]);

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
      if (pending.current.has(path)) continue;
      const request = gateway.read(path).then((document) => {
        if (gatewayRef.current !== gateway) return;
        setCache((current) => new Map(current).set(path, document));
        setErrors((current) => {
          if (!current.has(path)) return current;
          const next = new Map(current);
          next.delete(path);
          return next;
        });
      }).catch((error: unknown) => {
        if (gatewayRef.current !== gateway) return;
        setErrors((current) => new Map(current).set(
          path,
          error instanceof Error ? error.message : "The transcluded note could not be opened."
        ));
      }).finally(() => pending.current.delete(path));
      pending.current.set(path, request);
    }
    // requestKey captures the stable set of visible revision-aware requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, requestKey]);

  return resolved;
}
