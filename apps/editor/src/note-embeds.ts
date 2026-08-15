import { useEffect, useMemo, useRef, useState } from "react";
import { resolveFileReference } from "./file-references";
import { resolveLinkSuggestion, type LinkSuggestion } from "./links";
import { markdownReferences, type MarkdownReference } from "./markdown-references";
import type { CollectionFile, CollectionGateway, NoteDocument, NoteSummary } from "./model";
import { noteTitle } from "./note";

export type ResolvedNoteEmbed = MarkdownReference & {
  key: string;
  status: "ready" | "loading" | "missing" | "missing_fragment" | "cycle" | "error";
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

  const references = useMemo(() => markdownReferences(source).filter((reference) => (
    reference.kind === "embed" && reference.block
  )), [source]);

  const resolved = references.flatMap((reference): ResolvedNoteEmbed[] => {
    const key = `${reference.from}:${reference.to}`;
    const suggestion = reference.target
      ? resolveLinkSuggestion(reference.target, suggestions, sourcePath, reference.format)
      : suggestions.find((candidate) => candidate.path === sourcePath);
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

export function markdownFragment(body: string, anchor?: string): string | undefined {
  if (!anchor) return body;
  const decoded = decodeAnchor(anchor);
  if (decoded.startsWith("^")) {
    const blockId = decoded.slice(1).toLocaleLowerCase();
    const line = body.split(/\r?\n/).find((candidate) => {
      const match = candidate.match(/\s+\^([\p{L}\p{N}_-]+)\s*$/u);
      return match?.[1].toLocaleLowerCase() === blockId;
    });
    return line?.replace(/\s+\^[\p{L}\p{N}_-]+\s*$/u, "");
  }

  const lines = body.split(/\r?\n/);
  const requested = headingIdentity(decoded);
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[index]);
    if (!heading || headingIdentity(heading[2]) !== requested) continue;
    const level = heading[1].length;
    let end = index + 1;
    while (end < lines.length) {
      const next = /^(#{1,6})\s+/.exec(lines[end]);
      if (next && next[1].length <= level) break;
      end += 1;
    }
    return lines.slice(index, end).join("\n").trimEnd();
  }
  return undefined;
}

function decodeAnchor(value: string): string {
  try { return decodeURIComponent(value).trim(); } catch { return value.trim(); }
}

function headingIdentity(value: string): string {
  return value.normalize("NFC")
    .toLocaleLowerCase()
    .replace(/[*_~`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
