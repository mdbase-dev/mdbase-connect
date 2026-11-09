// Comments as the mdbase.comment contract defines them: records of their own,
// anchored to a quote of the commented record's Markdown body. This is the one
// reading of the contract every mdbase app shares; nothing here knows which
// app is showing the comments or how it reaches the collection.
//
// Offsets in a stored text_position are Unicode code points of the body;
// everything else here (and CodeMirror) uses UTF-16 offsets.

export const COMMENT_CONTRACT = { id: "mdbase.comment", version: "1.0.0" } as const;

interface CommentQuote {
  readonly exact: string;
  readonly prefix?: string;
  readonly suffix?: string;
}

interface CommentTextPosition {
  readonly basis: { readonly profile: "markdown-body"; readonly hash: string };
  readonly unit: "unicode_code_point";
  readonly start: number;
  readonly end: number;
}

export interface CommentTarget {
  readonly quote: CommentQuote;
  readonly text_position?: CommentTextPosition;
}

type CommentMotivation = "commenting" | "replying" | "editing";

/** One comment record, through the contract's field names. */
export interface CommentRecord {
  readonly path: string;
  /** The link to the commented record, as stored (`[[chapters/method]]`). */
  readonly document: string;
  readonly inReplyTo?: string;
  readonly motivation: CommentMotivation;
  readonly target?: CommentTarget;
  readonly suggestion?: { readonly replacement: string; readonly outcome?: "accepted" | "rejected" };
  readonly status: "open" | "resolved";
  readonly resolvedBy?: string;
  readonly resolvedAt?: string;
  readonly createdBy?: string;
  readonly createdAt: string;
  readonly deletedAt?: string;
  /** The comment's text (its Markdown body). */
  readonly text: string;
}

export interface CommentThread {
  readonly root: CommentRecord;
  /** Replies, oldest first. */
  readonly replies: readonly CommentRecord[];
}

/** The contract's fields as JSON, under the contract's names. */
export type CommentFields = Record<string, unknown>;

/** How much text either side of a quote is kept to tell repeated occurrences apart. */
const QUOTE_CONTEXT = 32;

const string = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const nonEmpty = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const object = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

function parseTarget(value: unknown): CommentTarget | undefined {
  const quote = object(object(value)?.["quote"]);
  const exact = string(quote?.["exact"]);
  if (!quote || exact === undefined) return undefined;
  const prefix = string(quote["prefix"]);
  const suffix = string(quote["suffix"]);
  if (!exact && !prefix && !suffix) return undefined;
  const position = object(object(value)?.["text_position"]);
  const basis = object(position?.["basis"]);
  const start = position?.["start"];
  const end = position?.["end"];
  const hash = string(basis?.["hash"]);
  const text_position: CommentTextPosition | undefined =
    basis?.["profile"] === "markdown-body" && hash && position?.["unit"] === "unicode_code_point" && Number.isInteger(start) && Number.isInteger(end)
      ? { basis: { profile: "markdown-body", hash }, unit: "unicode_code_point", start: start as number, end: end as number }
      : undefined;
  return { quote: { exact, ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}) }, ...(text_position ? { text_position } : {}) };
}

/**
 * A comment from a record's contract projection (frontmatter under the
 * contract's field names) and body; null when it is not a usable comment.
 */
export function commentFromRecord(path: string, fields: Readonly<CommentFields> | undefined, body: string): CommentRecord | null {
  const document = nonEmpty(fields?.["document"]);
  // YAML reads an unquoted timestamp as a date; either form is the same instant.
  const created = fields?.["created_at"];
  const createdAt = created instanceof Date ? created.toISOString() : nonEmpty(created);
  if (!fields || !document || !createdAt) return null;
  const motivation = fields["motivation"] === "replying" || fields["motivation"] === "editing" ? fields["motivation"] : "commenting";
  const target = parseTarget(fields["target"]);
  const rawSuggestion = object(fields["suggestion"]);
  const replacement = string(rawSuggestion?.["replacement"]);
  const outcome = rawSuggestion?.["outcome"] === "accepted" || rawSuggestion?.["outcome"] === "rejected" ? rawSuggestion["outcome"] : undefined;
  const optional = (key: string, field: string) => {
    const v = nonEmpty(fields[field]);
    return v ? { [key]: v } : {};
  };
  return {
    path,
    document,
    motivation,
    status: fields["status"] === "resolved" ? "resolved" : "open",
    createdAt,
    text: body.trim(),
    ...(target ? { target } : {}),
    ...(replacement !== undefined ? { suggestion: { replacement, ...(outcome ? { outcome } : {}) } } : {}),
    ...optional("inReplyTo", "in_reply_to"),
    ...optional("resolvedBy", "resolved_by"),
    ...optional("resolvedAt", "resolved_at"),
    ...optional("createdBy", "created_by"),
    ...optional("deletedAt", "deleted_at"),
  };
}

/** The path part of a link (`[[chapters/method|Method]]` → `chapters/method`), or the value as it is. */
export function linkPath(link: string): string {
  const inner = /^\s*\[\[([^\]]*)\]\]\s*$/.exec(link)?.[1] ?? link;
  return (inner.split("|")[0] ?? "").split("#")[0]?.trim() ?? "";
}

/** The link a comment stores for a record path: `[[chapters/method]]`. */
export const recordLink = (path: string): string => `[[${path.replace(/\.md$/i, "")}]]`;

const withoutExtension = (path: string) => path.replace(/\.md$/i, "").toLowerCase();

/**
 * The record paths of one collection generation, for following the links
 * comments store. A link names an exact collection path, a path relative to
 * the linking record, or a file name that is unique in the collection.
 */
export class RecordPaths {
  private readonly paths = new Map<string, string>();
  private readonly basenames = new Map<string, string | null>();

  constructor(paths: Iterable<string>) {
    for (const path of paths) {
      const key = withoutExtension(path);
      this.paths.set(key, path);
      const name = key.slice(key.lastIndexOf("/") + 1);
      this.basenames.set(name, this.basenames.has(name) ? null : path);
    }
  }

  /** The record a link written in `from` leads to, or null. */
  resolve(link: string, from: string): string | null {
    let target = linkPath(link).replace(/^\.\//, "");
    try { target = decodeURI(target); } catch { /* A stray % is part of the name. */ }
    const key = withoutExtension(normalize(target));
    if (!key) return null;
    const exact = this.paths.get(key);
    if (exact) return exact;
    const folder = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
    const relative = this.paths.get(withoutExtension(normalize(folder ? `${folder}/${target}` : target)));
    if (relative) return relative;
    return key.includes("/") ? null : this.basenames.get(key) ?? null;
  }
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * Comments grouped into threads, oldest thread first. A reply whose first
 * comment is missing (deleted by hand, not yet synced) becomes a thread of its own.
 */
export function commentThreads(comments: readonly CommentRecord[]): CommentThread[] {
  const byPath = new Map(comments.map((c) => [c.path, c]));
  const paths = new RecordPaths(byPath.keys());
  const rootOf = (c: CommentRecord) => {
    if (!c.inReplyTo) return undefined;
    const path = paths.resolve(c.inReplyTo, c.path);
    return path ? byPath.get(path) : undefined;
  };
  const replies = new Map<CommentRecord, CommentRecord[]>();
  const roots: CommentRecord[] = [];
  for (const c of comments) {
    const root = rootOf(c);
    if (root && !root.inReplyTo) {
      let thread = replies.get(root);
      if (!thread) { thread = []; replies.set(root, thread); }
      thread.push(c);
    } else roots.push(c);
  }
  const byTime = (a: CommentRecord, b: CommentRecord) => a.createdAt.localeCompare(b.createdAt) || a.path.localeCompare(b.path);
  return roots.sort(byTime).map((root) => ({ root, replies: (replies.get(root) ?? []).sort(byTime) }));
}

/** Code points in `text` before UTF-16 offset `offset`. */
export function codePointOffset(text: string, offset: number): number {
  let points = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < offset) i++;
    points++;
  }
  return points;
}

/** The UTF-16 offset of code point `points` in `text` (the end when past it). */
export function utf16Offset(text: string, points: number): number {
  let i = 0;
  for (let p = 0; p < points && i < text.length; p++) {
    const c = text.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? 2 : 1;
  }
  return i;
}

/** `sha256:` and the hex SHA-256 of the body's UTF-8 bytes (the text_position basis). */
export async function bodyHash(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The target for the text between UTF-16 offsets `from` and `to` of `body`. */
export function targetFor(body: string, from: number, to: number, hash: string): CommentTarget {
  const exact = body.slice(from, to);
  const prefix = body.slice(Math.max(0, from - QUOTE_CONTEXT), from);
  const suffix = body.slice(to, to + QUOTE_CONTEXT);
  return {
    quote: { exact, ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}) },
    text_position: {
      basis: { profile: "markdown-body", hash },
      unit: "unicode_code_point",
      start: codePointOffset(body, from),
      end: codePointOffset(body, to),
    },
  };
}

export interface Located {
  readonly from: number;
  readonly to: number;
}

/** Characters of `a` and `b` that agree, counting back from their ends. */
function sharedEnd(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function sharedStart(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Where a target's quote is in `body` (UTF-16 offsets), or null when it is
 * detached. The recorded position is used when the quote is still there;
 * otherwise the occurrence whose surroundings best match the recorded prefix
 * and suffix wins, then the one nearest the recorded position.
 */
export function locate(body: string, target: CommentTarget): Located | null {
  const { exact, prefix = "", suffix = "" } = target.quote;
  const hint = target.text_position ? utf16Offset(body, target.text_position.start) : undefined;
  const context = (at: number, end: number) =>
    sharedEnd(body.slice(Math.max(0, at - prefix.length), at), prefix) + sharedStart(body.slice(end, end + suffix.length), suffix);
  if (hint !== undefined && body.slice(hint, hint + exact.length) === exact) {
    // An insertion point carries no text of its own: its context must still agree.
    if (exact || context(hint, hint) === prefix.length + suffix.length) return { from: hint, to: hint + exact.length };
  }
  // An insertion point is found by the text either side of it.
  const needle = exact || prefix + suffix;
  const shift = exact ? 0 : prefix.length;
  if (!needle) return null;
  let best: { at: number; score: number; distance: number } | null = null;
  for (let i = body.indexOf(needle); i >= 0; i = body.indexOf(needle, i + 1)) {
    const at = i + shift;
    const score = exact ? context(at, at + exact.length) : needle.length;
    const distance = hint === undefined ? 0 : Math.abs(at - hint);
    if (!best || score > best.score || (score === best.score && distance < best.distance)) best = { at, score, distance };
  }
  return best ? { from: best.at, to: best.at + exact.length } : null;
}

/**
 * A target as an editor that keeps its text with `\n` line breaks sees it.
 * The recorded position counted the stored line breaks, so it is dropped when
 * they differ and the quote alone finds the passage.
 */
export function editorTarget(target: CommentTarget): CommentTarget {
  const { exact, prefix, suffix } = target.quote;
  if (![exact, prefix, suffix].some((part) => part?.includes("\r"))) return target;
  const lf = (part: string) => part.replace(/\r\n/g, "\n");
  return { quote: { exact: lf(exact), ...(prefix ? { prefix: lf(prefix) } : {}), ...(suffix ? { suffix: lf(suffix) } : {}) } };
}

/** The body with a suggestion applied, or null when its quote cannot be found exactly. */
export function applySuggestion(body: string, target: CommentTarget, replacement: string): string | null {
  const at = locate(body, target);
  if (!at || body.slice(at.from, at.to) !== target.quote.exact) return null;
  return body.slice(0, at.from) + replacement + body.slice(at.to);
}

export interface PlacedThread {
  readonly thread: CommentThread;
  /** Where its passage is now: "whole" for a comment on the whole record, null when detached. */
  readonly at: Located | "whole" | null;
}

/** A thread shows unless its first comment was withdrawn and nobody replied. */
const shown = (t: CommentThread) => !t.root.deletedAt || t.replies.some((r) => !r.deletedAt);

/** The threads whose first comment is on `record`. */
export function recordThreads(record: string, comments: readonly CommentRecord[], paths: RecordPaths): CommentThread[] {
  return commentThreads(comments).filter((thread) => shown(thread) && paths.resolve(thread.root.document, thread.root.path) === record);
}

/**
 * Threads where they are in `body` now, in reading order: whole-record
 * threads, then by position, then detached threads.
 */
export function placeThreads(threads: readonly CommentThread[], body: string): PlacedThread[] {
  const position = (p: PlacedThread) => (p.at === "whole" ? -1 : p.at === null ? Number.MAX_SAFE_INTEGER : p.at.from);
  return threads
    .map((thread): PlacedThread => ({ thread, at: thread.root.target ? locate(body, thread.root.target) : "whole" }))
    .sort((a, b) => position(a) - position(b));
}

interface NewComment {
  /** Path of the commented record. */
  readonly document: string;
  readonly target?: CommentTarget;
  /** The thread a reply belongs to. */
  readonly thread?: CommentRecord;
  /** A suggested edit: the text to put in place of the target's quote. */
  readonly replacement?: string;
}

export type CommentChange =
  | { readonly kind: "resolve"; readonly outcome?: "accepted" | "rejected" }
  | { readonly kind: "reopen" }
  | { readonly kind: "withdraw" };

/** A new comment's path: `comments/` and a sortable, unique name. */
export function commentPath(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `comments/${stamp}-${Math.random().toString(36).slice(2, 8)}.md`;
}

/** The contract fields of a new comment; `author` is a link to a person record. */
export function newCommentFields(input: NewComment, now: Date, author: string | undefined): CommentFields {
  const motivation = input.thread ? "replying" : input.replacement !== undefined ? "editing" : "commenting";
  return {
    document: recordLink(input.document),
    ...(input.thread ? { in_reply_to: recordLink(input.thread.path) } : {}),
    motivation,
    ...(input.target && !input.thread ? { target: input.target } : {}),
    ...(input.replacement !== undefined && !input.thread ? { suggestion: { replacement: input.replacement } } : {}),
    ...(input.thread ? {} : { status: "open" }),
    ...(author ? { created_by: author } : {}),
    created_at: now.toISOString(),
  };
}

/** The contract fields a change writes, and the body it leaves (undefined keeps it). */
export function changeFields(comment: CommentRecord, change: CommentChange, now: Date, author: string | undefined): { fields: CommentFields; body?: string } {
  const at = now.toISOString();
  switch (change.kind) {
    case "resolve":
      return {
        fields: {
          status: "resolved",
          resolved_at: at,
          ...(author ? { resolved_by: author } : {}),
          ...(change.outcome && comment.suggestion ? { suggestion: { ...comment.suggestion, outcome: change.outcome } } : {}),
          modified_at: at,
        },
      };
    case "reopen":
      // resolved_by and resolved_at stay as a record of the last resolution:
      // an update can set keys but not remove them.
      return { fields: { status: "open", modified_at: at } };
    case "withdraw":
      return { fields: { deleted_at: at, modified_at: at }, body: "" };
  }
}

/**
 * Whether new comments are signed, and if not, why: the account has no person
 * record here, several records (or an invalid one) claim it, the app was not
 * allowed to see the account, or the account could not be checked.
 */
type CommentSigning =
  | { readonly kind: "linked" }
  | { readonly kind: "unlinked" }
  | { readonly kind: "conflict"; readonly paths: readonly string[] }
  | { readonly kind: "not-approved" }
  | { readonly kind: "unavailable"; readonly reason: string };

/** Person records by link key (see `personKey`), and the signed-in account's own. */
export interface CommentPeople {
  readonly names: ReadonlyMap<string, string>;
  /** The link to the signed-in account's person record, when it has exactly one. */
  readonly me?: { readonly link: string; readonly name: string };
  /** Unknown until the account has been checked. */
  readonly signing?: CommentSigning;
}

export const NO_COMMENT_PEOPLE: CommentPeople = { names: new Map() };

/** A record path or link, compared as links resolve: without `.md`, ignoring case. */
export const personKey = (pathOrLink: string): string => withoutExtension(linkPath(pathOrLink));

/** The display name for an author link: its person record's name, else the link's own text. */
export function personName(link: string | undefined, people: CommentPeople): string | undefined {
  if (!link) return undefined;
  const key = personKey(link);
  const exact = people.names.get(key);
  if (exact) return exact;
  // `[[Alex Rivera]]` resolves by file name when that name is unique.
  if (!key.includes("/")) {
    const matches = [...people.names].filter(([path]) => path.endsWith(`/${key}`));
    if (matches.length === 1) return matches[0]?.[1];
  }
  const alias = /\|([^\]]+)\]\]/.exec(link)?.[1];
  return alias?.trim() || linkPath(link).split("/").pop() || undefined;
}

/** Whether `comment` was written by the signed-in account's person. */
export function writtenByMe(comment: CommentRecord, people: CommentPeople): boolean {
  return Boolean(people.me && comment.createdBy && personKey(comment.createdBy) === personKey(people.me.link));
}

/**
 * A passage of Markdown as it reads: emphasis, code and link markup dropped,
 * soft line breaks as spaces ("*modal picture*" → "modal picture").
 */
export function plainPassage(passage: string): string {
  return passage
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/\[\[(?:[^\]|\n]*\|)?([^\]\n]*)\]\]/g, "$1")
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/\*(?=\S)([^*\n]*?\S)\*/g, "$1")
    .replace(/(?<![\p{L}\p{N}])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}])/gu, "$1")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/([^\n])\r?\n(?!\r?\n)[ \t]*/g, "$1 ");
}

/** A passage on one line, shortened to about 60 characters. */
export function clipPassage(passage: string): string {
  const one = plainPassage(passage).replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 57)}…` : one;
}

/** A run of comment text as it reads: plain, emphasised, code, or a link. */
type InlinePiece = { readonly kind: "text" | "em" | "strong" | "code"; readonly text: string } | { readonly kind: "link"; readonly text: string; readonly href: string };

/**
 * The light Markdown a comment uses (emphasis, code, links), as pieces to
 * render; anything else stays as written. Only http(s) links are links.
 */
export function inlinePieces(text: string): InlinePiece[] {
  const out: InlinePiece[] = [];
  const pattern = /`([^`\n]+)`|\*\*(?=\S)([^\n]*?\S)\*\*|\*(?=\S)([^*\n]*?\S)\*|(?<![\p{L}\p{N}])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}])|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>")\]]+[^\s<>")\].,;:!?])/gu;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) });
    if (m[1] !== undefined) out.push({ kind: "code", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "strong", text: m[2] });
    else if (m[3] !== undefined || m[4] !== undefined) out.push({ kind: "em", text: (m[3] ?? m[4]) as string });
    else if (m[5] !== undefined && m[6] !== undefined) out.push({ kind: "link", text: m[5], href: m[6] });
    else if (m[7] !== undefined) out.push({ kind: "link", text: m[7], href: m[7] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/** "5 minutes ago", "yesterday", or a date for anything older than a week, in `locale`. */
export function when(iso: string, locale: string | undefined, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const seconds = Math.round((then - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return relative.format(0, "second");
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), "hour");
  if (abs < 7 * 86_400) return relative.format(Math.round(seconds / 86_400), "day");
  return new Date(then).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}
