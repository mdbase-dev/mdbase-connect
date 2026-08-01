import type { JsonObject } from "@mdbase-dev/connect";
import { Document, isMap, isScalar, parseDocument } from "yaml";

export interface ParsedRecordSource {
  frontmatter: JsonObject;
  body: string;
}

export function replaceDocumentFrontmatter(source: string, next: JsonObject): string {
  const parts = sourceParts(source);
  if (!parts) {
    if (Object.keys(next).length === 0) return source;
    const document = new Document(next);
    return `---\n${document.toString({ lineWidth: 0 })}---\n${source}`;
  }

  const document = parseDocument(parts.yaml, { keepSourceTokens: true });
  if (document.errors.length) throw new Error(document.errors[0].message);
  if (document.contents === null && parts.yaml.trim() !== "") {
    throw new Error("Record frontmatter must be a YAML mapping.");
  }
  if (document.contents !== null && !isMap(document.contents)) {
    throw new Error("Record frontmatter must be a YAML mapping.");
  }
  if (Object.keys(next).length === 0) return `${parts.bom}${parts.body}`;
  if (document.contents === null) {
    document.set("__mdbase_placeholder", true);
    document.delete("__mdbase_placeholder");
  }
  const contents = document.contents;
  if (!isMap(contents)) throw new Error("Record frontmatter must be a YAML mapping.");

  const existing = new Set<string>();
  for (const item of contents.items) {
    if (isScalar(item.key) && typeof item.key.value === "string") existing.add(item.key.value);
  }
  for (const name of existing) {
    if (!(name in next)) document.delete(name);
  }
  for (const [name, value] of Object.entries(next)) document.set(name, structuredClone(value));

  const yaml = normalizeLineEndings(document.toString({ lineWidth: 0 }), parts.newline);
  return `${parts.bom}${parts.opening}${yaml}${parts.closing}${parts.body}`;
}

export function parseRecordSource(source: string): ParsedRecordSource {
  const parts = sourceParts(source);
  if (!parts) return { frontmatter: {}, body: source };
  const document = parseDocument(parts.yaml);
  if (document.errors.length) throw new Error(document.errors[0].message);
  const value = document.toJS() as unknown;
  if (value === null && parts.yaml.trim() !== "") {
    throw new Error("Record frontmatter must be a YAML mapping.");
  }
  if (value !== null && (!value || Array.isArray(value) || typeof value !== "object")) {
    throw new Error("Record frontmatter must be a YAML mapping.");
  }
  return { frontmatter: (value ?? {}) as JsonObject, body: parts.body };
}

export function composeRecordSource(frontmatter: JsonObject, body: string): string {
  if (Object.keys(frontmatter).length === 0) return body;
  const document = new Document(frontmatter);
  return `---\n${document.toString({ lineWidth: 0 })}---\n${body}`;
}

function sourceParts(source: string): {
  bom: string;
  opening: string;
  yaml: string;
  closing: string;
  body: string;
  newline: "\n" | "\r\n";
} | undefined {
  const bom = source.startsWith("\u{feff}") ? "\u{feff}" : "";
  const content = source.slice(bom.length);
  const opening = /^---[ \t]*(\r?\n)/.exec(content);
  if (!opening) return undefined;
  const afterOpening = content.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(afterOpening);
  if (!closing || closing.index === undefined) return undefined;
  return {
    bom,
    opening: opening[0],
    yaml: afterOpening.slice(0, closing.index),
    closing: closing[0],
    body: afterOpening.slice(closing.index + closing[0].length),
    newline: opening[1] === "\r\n" ? "\r\n" : "\n"
  };
}

function normalizeLineEndings(value: string, newline: "\n" | "\r\n"): string {
  const normalized = value.replace(/\r\n/g, "\n");
  return newline === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized;
}
