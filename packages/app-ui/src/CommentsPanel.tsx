// The comments on a record, or on the several records of one piece of
// writing: threads in reading order, with replies, resolving, and suggested
// edits to accept or reject. A new comment or suggestion starts from a passage
// the app hands in (`pending`). Style with `@mdbase-dev/ui/comments.css`.
import { plural, t } from "@lingui/core/macro";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from "react";

import {
  clipPassage,
  inlinePieces,
  personKey,
  personName,
  plainPassage,
  threadIsNew,
  when as relativeTime,
  writtenByMe,
  type CommentChange,
  type CommentPeople,
  type CommentRecord,
  type CommentThread,
  type PlacedThread,
} from "./comments.js";
import { i18n, useLocaleRevision } from "./i18n.js";
import { Select } from "./Select.js";

const when = (iso: string) => relativeTime(iso, i18n.locale);

/** What a write came to; a failure's message is shown beside the action that made it. */
export type CommentResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** A comment being written: on `quote`, at a point in the text (an empty quote), or on the whole record. */
export interface PendingComment {
  readonly quote?: string;
  /** A suggested edit to the passage (or an insertion at the point), not a comment on it. */
  readonly suggest?: boolean;
  /** Where it is, such as a chapter's title, when the panel covers several records. */
  readonly on?: string;
}

/** Replies being written, by thread, so they outlast the panel being closed. */
export type CommentDrafts = Map<string, { reply: string; replying: boolean }>;

type Filter = "open" | "resolved";

const PAGE = 50;

/** Rows a page at a time; revealing a distant row opens its page, not everything before it. */
function useRowWindow() {
  const [range, setRange] = useState({ from: 0, size: PAGE });
  const reveal = useCallback((rank: number) => {
    if (rank < 0) return;
    setRange((r) => (rank >= r.from && rank < r.from + r.size ? r : { from: Math.floor(rank / PAGE) * PAGE, size: PAGE }));
  }, []);
  const reset = useCallback(() => setRange({ from: 0, size: PAGE }), []);
  const more = useCallback(() => setRange((r) => ({ ...r, size: r.size + PAGE })), []);
  const previous = useCallback(() => setRange((r) => ({ from: Math.max(0, r.from - PAGE), size: PAGE })), []);
  return { ...range, reveal, reset, more, previous };
}

interface CommentsPanelProps {
  readonly threads: readonly PlacedThread[];
  readonly people: CommentPeople;
  /** Threads are still being read. */
  readonly loading?: boolean;
  /** Why comments could not be read. */
  readonly problem?: string | undefined;
  readonly onRetry?: (() => void) | undefined;
  /** The selected thread (its first comment's path). */
  readonly active: string | null;
  readonly pending: PendingComment | null;
  /** Absent when this person cannot write comments here. */
  readonly onStart?: (() => void) | undefined;
  /** Said when there is nothing open: how to begin a comment in this app. */
  readonly hint?: ReactNode;
  /** Shown above the threads, such as why new comments will not be signed. */
  readonly notice?: ReactNode;
  readonly onSelect: (placed: PlacedThread) => void;
  /** `replacement` is the suggested text when `pending.suggest`. */
  readonly onSubmit: (text: string, replacement?: string) => Promise<CommentResult>;
  readonly onCancel: () => void;
  readonly onReply?: ((thread: CommentThread, text: string) => Promise<CommentResult>) | undefined;
  readonly onChange?: ((comment: CommentRecord, change: CommentChange) => Promise<CommentResult>) | undefined;
  /** Makes a suggested edit and resolves its thread. */
  readonly onAccept?: ((placed: PlacedThread) => Promise<CommentResult>) | undefined;
  /** Opens a comment's own record. */
  readonly onOpenRecord?: ((path: string) => void) | undefined;
  /** Heads each record's threads with its title, when the threads are on several records. */
  readonly recordTitle?: ((record: string) => string) | undefined;
  /** When this was last open here, for marking what others have written since. */
  readonly since?: string | undefined;
  /** Kept by the app when replies in progress should outlast this panel. */
  readonly drafts?: CommentDrafts | undefined;
}

export function CommentsPanel({ threads, people, loading = false, problem, onRetry, active, pending, onStart, hint, notice, onSelect, onSubmit, onCancel, onReply, onChange, onAccept, onOpenRecord, recordTitle, since, drafts: providedDrafts }: CommentsPanelProps): JSX.Element {
  useLocaleRevision();
  const [filter, setFilter] = useState<Filter>("open");
  // Whose threads: everyone's, what is new since the last visit, one's own, or one person's.
  const [who, setWho] = useState("all");
  const panel = useRef<HTMLElement>(null);
  const ownDrafts = useRef<CommentDrafts>(new Map());
  const drafts = providedDrafts ?? ownDrafts.current;
  const rows = useRowWindow();
  const me = people.me ? personKey(people.me.link) : undefined;
  const isNew = (p: PlacedThread) => threadIsNew(p.thread, since, people);
  const authors = useMemo(() => {
    const names = new Map<string, string>();
    for (const p of threads) for (const c of [p.thread.root, ...p.thread.replies]) {
      if (!c.createdBy) continue;
      const key = personKey(c.createdBy);
      if (!names.has(key)) names.set(key, personName(c.createdBy, people) ?? c.createdBy);
    }
    return [...names].sort((a, b) => a[1].localeCompare(b[1]));
  }, [threads, people]);
  const wanted = (p: PlacedThread) => {
    if (who === "all") return true;
    if (who === "new") return isNew(p);
    const key = who === "mine" ? me : who;
    return [p.thread.root, ...p.thread.replies].some((c) => c.createdBy !== undefined && personKey(c.createdBy) === key);
  };
  const newCount = threads.filter((p) => p.thread.root.status === "open" && isNew(p)).length;
  const groups = { open: threads.filter((p) => p.thread.root.status === "open" && wanted(p)), resolved: threads.filter((p) => p.thread.root.status === "resolved" && wanted(p)) };
  const logical = groups[filter];
  const shown = logical.slice(rows.from, rows.from + rows.size);

  // Arrow keys (or j and k) move between threads from their passage.
  const onListKey = (e: KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    if (!target.matches(".mdbase-thread-anchor")) return;
    const path = target.closest<HTMLElement>("[data-thread]")?.dataset["thread"];
    const rank = logical.findIndex((p) => p.thread.root.path === path);
    const direction = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
    const next = logical[rank + direction];
    if (!direction || !next) return;
    e.preventDefault();
    rows.reveal(rank + direction);
    requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>(`[data-thread="${CSS.escape(next.thread.root.path)}"] .mdbase-thread-anchor`)?.focus());
  };

  // A thread selected in the editor comes into view (and shows, even when resolved).
  useEffect(() => {
    if (!active) return;
    const hit = threads.find((p) => p.thread.root.path === active);
    if (hit) {
      setFilter(hit.thread.root.status);
      rows.reveal(groups[hit.thread.root.status].indexOf(hit));
    }
    const frame = requestAnimationFrame(() => panel.current?.querySelector(`[data-thread="${CSS.escape(active)}"]`)?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new selection moves the list
  }, [active]);

  let lastRecord: string | undefined;
  return (
    <section ref={panel} className="mdbase-comments" aria-label={t({ message: "Comments" })} onKeyDown={onListKey}>
      <div className="mdbase-comments-bar">
        <div className="mdbase-comments-filter" role="group" aria-label={t({ message: "Show" })}>
          {(["open", "resolved"] as const).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => { setFilter(f); rows.reset(); }}>
              {f === "open" ? t({ message: "Open", context: "Comment status" }) : t({ message: "Resolved", context: "Comment status" })} <span className="mdbase-comments-count">{groups[f].length}</span>
            </button>
          ))}
        </div>
        {onStart && <button type="button" className="mdbase-button" onClick={onStart} disabled={pending !== null}>{t({ message: "New comment" })}</button>}
      </div>
      {threads.length > 0 && (authors.length > 1 || newCount > 0) && (
        <div className="mdbase-comments-who">
          <Select
            aria-label={t({ message: "Whose comments" })}
            value={who}
            onChange={(value) => { setWho(value); rows.reset(); }}
            options={[
              { value: "all", label: t({ message: "Everyone" }) },
              ...(newCount > 0 || who === "new" ? [{ value: "new", label: t({ message: `New since last visit (${newCount})` }) }] : []),
              ...(me ? [{ value: "mine", label: t({ message: "Mine" }) }] : []),
              ...authors.map(([value, label]) => ({ value, label })),
            ]}
          />
        </div>
      )}
      {notice}
      {pending && <Composer key={`${pending.on ?? ""}\0${pending.quote ?? "\0whole"}\0${pending.suggest ? "suggest" : ""}`} pending={pending} signer={people.signing?.kind === "linked" ? people.me?.name : undefined} onSubmit={onSubmit} onCancel={onCancel} />}
      {loading && <p className="mdbase-comments-note" role="status">{t({ message: "Loading comments…" })}</p>}
      {problem && <p className="mdbase-comments-note">{t({ message: `Comments could not be loaded: ${problem}` })} {onRetry && <button type="button" className="mdbase-thread-action" onClick={onRetry}>{t({ message: "Try again" })}</button>}</p>}
      {!loading && !problem && !shown.length && !pending && (
        <div className="mdbase-comments-empty">
          {filter === "open" ? <><p><strong>{t({ message: "No open comments" })}</strong></p>{hint && <p>{hint}</p>}</> : <p>{t({ message: "Nothing resolved yet." })}</p>}
        </div>
      )}
      <ul className="mdbase-threads">
        {shown.map((p) => {
          const heading = recordTitle && p.record !== undefined && p.record !== lastRecord
            ? <li className="mdbase-threads-record" key={`\0${p.record}`}><h3 title={recordTitle(p.record)}>{recordTitle(p.record)}</h3></li>
            : null;
          lastRecord = p.record;
          return [
            heading,
            <Thread key={p.thread.root.path} placed={p} people={people} drafts={drafts} isNew={isNew(p)} active={p.thread.root.path === active} onSelect={onSelect} onReply={onReply} onChange={onChange} onAccept={onAccept} onOpenRecord={onOpenRecord} />,
          ];
        })}
      </ul>
      {rows.from > 0 && <button type="button" className="mdbase-comments-more" onClick={rows.previous}>{t({ message: "Show previous 50 comments" })}</button>}
      {logical.length > rows.from + rows.size && <button type="button" className="mdbase-comments-more" onClick={rows.more}>{t({ message: `Show 50 more comments · ${logical.length}` })}</button>}
    </section>
  );
}

/** Runs an action, showing it is busy and what went wrong. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<CommentResult>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (!result.ok) setError(result.message);
    return result.ok;
  };
  return { busy, error, run };
}

const submitsOnModEnter = (event: { key: string; metaKey: boolean; ctrlKey: boolean }) => event.key === "Enter" && (event.metaKey || event.ctrlKey);

function Composer({ pending, signer, onSubmit, onCancel }: { pending: PendingComment; signer: string | undefined; onSubmit(text: string, replacement?: string): Promise<CommentResult>; onCancel(): void }) {
  const quote = pending.quote ?? "";
  const suggest = pending.suggest === true;
  const [text, setText] = useState("");
  const [replacement, setReplacement] = useState(quote);
  const first = useRef<HTMLTextAreaElement>(null);
  const { busy, error, run } = useAction();
  useEffect(() => first.current?.focus(), []);
  const empty = suggest ? replacement === quote : !text.trim();
  const submit = () => void run(() => onSubmit(text, suggest ? replacement : undefined));
  const by = [signer ? t({ message: `as ${signer}` }) : "", pending.on ?? ""].filter(Boolean).join(" · ");
  return (
    <form
      className="mdbase-thread mdbase-comment-composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (!empty) submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
        else if (submitsOnModEnter(e) && !empty) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <p className="mdbase-comment-composer-title">
        <strong>{suggest ? t({ message: "Suggest an edit" }) : t({ message: "New comment" })}</strong>
        {by && <span title={by}>{by}</span>}
      </p>
      {quote
        ? <blockquote className="mdbase-thread-quote">{plainPassage(quote)}</blockquote>
        : <p className="mdbase-thread-whole">{pending.quote === undefined ? t({ message: "Whole text" }) : suggest ? t({ message: "Insert at the cursor" }) : t({ message: "At the cursor" })}</p>}
      {suggest && (
        <label className="mdbase-comment-composer-field">
          <span>{t({ message: "Replace with" })}</span>
          <textarea ref={first} className="mdbase-field" rows={3} value={replacement} onChange={(e) => setReplacement(e.target.value)} aria-label={t({ message: "Suggested text" })} />
        </label>
      )}
      <textarea ref={suggest ? undefined : first} className="mdbase-field" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={suggest ? t({ message: "Why (optional)" }) : t({ message: "Comment" })} aria-label={suggest ? t({ message: "Reason for the suggestion" }) : t({ message: "Comment" })} />
      {error && <p className="mdbase-comments-error" role="alert">{error}</p>}
      <div className="mdbase-thread-actions">
        <button type="submit" className="mdbase-button is-primary" disabled={busy || empty}>{suggest ? t({ message: "Suggest" }) : t({ message: "Comment" })}</button>
        <button type="button" className="mdbase-button" onClick={onCancel} disabled={busy}>{t({ message: "Cancel" })}</button>
      </div>
    </form>
  );
}

const Thread = memo(function Thread({ placed, people, drafts, isNew, active, onSelect, onReply, onChange, onAccept, onOpenRecord }: {
  placed: PlacedThread;
  people: CommentPeople;
  drafts: CommentDrafts;
  isNew: boolean;
  active: boolean;
} & Pick<CommentsPanelProps, "onSelect" | "onReply" | "onChange" | "onAccept" | "onOpenRecord">) {
  const { thread, at } = placed;
  const { root } = thread;
  const [reply, setReply] = useState(() => drafts.get(root.path)?.reply ?? "");
  const [replying, setReplying] = useState(() => drafts.get(root.path)?.replying ?? false);
  useEffect(() => { drafts.set(root.path, { reply, replying }); }, [drafts, root.path, reply, replying]);
  const [repliesShown, setRepliesShown] = useState(PAGE);
  const { busy, error, run } = useAction();
  const suggestion = root.motivation === "editing" && root.suggestion ? root.suggestion : null;
  const open = root.status === "open";
  // An unsigned comment has no author to check, so whoever can write may withdraw it.
  const mine = (c: CommentRecord) => !c.createdBy || writtenByMe(c, people);
  const withdraw = (c: CommentRecord) => onChange && !c.deletedAt && mine(c)
    ? <button type="button" className="mdbase-thread-action is-quiet" disabled={busy} onClick={() => void run(() => onChange(c, { kind: "withdraw" }))}>{t({ message: "Withdraw" })}</button>
    : null;

  const resolver = root.resolvedBy ? personName(root.resolvedBy, people) : undefined;
  const state = suggestion?.outcome === "accepted" ? t({ message: "Accepted" }) : suggestion?.outcome === "rejected" ? t({ message: "Rejected" }) : t({ message: "Resolved" });
  const resolvedNote = open ? null : [state, resolver ? t({ message: `by ${resolver}` }) : "", root.resolvedAt ? when(root.resolvedAt) : ""].filter(Boolean).join(" ");

  return (
    <li className={`mdbase-thread${active ? " is-active" : ""}${open ? "" : " is-resolved"}`} data-thread={root.path}>
      <button type="button" className="mdbase-thread-anchor" onClick={() => onSelect(placed)} title={at === null ? t({ message: "This passage is no longer in the text" }) : t({ message: "Show in the editor" })}>
        {isNew && <span className="mdbase-thread-new">{t({ message: "New since your last visit" })}</span>}
        {suggestion ? <Suggestion root={root} /> : root.target
          ? <blockquote className="mdbase-thread-quote">{plainPassage(root.target.quote.exact) || t({ message: "(a point in the text)" })}</blockquote>
          : <span className="mdbase-thread-whole">{t({ message: "Whole text" })}</span>}
        {at === null && <span className="mdbase-thread-detached">{t({ message: "The text it was on has changed" })}</span>}
      </button>
      <Comment comment={root} people={people} />
      {thread.replies.slice(0, repliesShown).map((r) => <Comment key={r.path} comment={r} people={people} reply>{withdraw(r)}</Comment>)}
      {thread.replies.length > repliesShown && <button type="button" className="mdbase-comments-more" onClick={() => setRepliesShown((n) => n + PAGE)}>{t({ message: `Show 50 more replies · ${thread.replies.length}` })}</button>}
      {resolvedNote && <p className="mdbase-thread-resolved">{resolvedNote}</p>}
      {error && <p className="mdbase-comments-error" role="alert">{error}</p>}
      {replying && onReply ? (
        <form
          className="mdbase-thread-reply"
          onSubmit={(e) => {
            e.preventDefault();
            if (reply.trim()) void run(() => onReply(thread, reply)).then((ok) => ok && (setReply(""), setReplying(false)));
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.stopPropagation(); setReplying(false); }
            else if (submitsOnModEnter(e)) {
              e.preventDefault();
              e.currentTarget.requestSubmit();
            }
          }}
        >
          <textarea className="mdbase-field" rows={2} autoFocus value={reply} onChange={(e) => setReply(e.target.value)} placeholder={t({ message: "Reply" })} aria-label={t({ message: "Reply" })} />
          <div className="mdbase-thread-actions">
            <button type="submit" className="mdbase-button is-primary" disabled={busy || !reply.trim()}>{t({ message: "Reply" })}</button>
            <button type="button" className="mdbase-button" onClick={() => setReplying(false)}>{t({ message: "Cancel" })}</button>
          </div>
        </form>
      ) : (
        <div className="mdbase-thread-actions">
          {open && suggestion && onChange && (
            <>
              {onAccept && <button type="button" className="mdbase-button is-primary" disabled={busy || at === null} onClick={() => void run(() => onAccept(placed))} title={at === null ? t({ message: "The suggested text is no longer there" }) : t({ message: "Make this edit" })}>{t({ message: "Accept" })}</button>}
              <button type="button" className="mdbase-button" disabled={busy} onClick={() => void run(() => onChange(root, { kind: "resolve", outcome: "rejected" }))}>{t({ message: "Reject" })}</button>
            </>
          )}
          {onReply && <button type="button" className="mdbase-thread-action" onClick={() => setReplying(true)}>{t({ message: "Reply" })}</button>}
          {open && !suggestion && onChange && <button type="button" className="mdbase-thread-action" disabled={busy} onClick={() => void run(() => onChange(root, { kind: "resolve" }))}>{t({ message: "Resolve" })}</button>}
          {!open && onChange && <button type="button" className="mdbase-thread-action" disabled={busy} onClick={() => void run(() => onChange(root, { kind: "reopen" }))}>{t({ message: "Reopen" })}</button>}
          {!thread.replies.length && withdraw(root)}
          {onOpenRecord && <button type="button" className="mdbase-thread-action is-quiet" onClick={() => onOpenRecord(root.path)}>{t({ message: "Open file" })}</button>}
        </div>
      )}
    </li>
  );
});

/** A comment's text with its light Markdown rendered. */
function InlineText({ text }: { text: string }) {
  return (
    <>
      {inlinePieces(text).map((piece, i) =>
        piece.kind === "link" ? <a key={i} href={piece.href} target="_blank" rel="noopener noreferrer">{piece.text}</a>
          : piece.kind === "em" ? <em key={i}>{piece.text}</em>
          : piece.kind === "strong" ? <strong key={i}>{piece.text}</strong>
          : piece.kind === "code" ? <code key={i}>{piece.text}</code>
          : piece.text,
      )}
    </>
  );
}

/** "Replace “x” with “y”", "Delete “x”" or "Insert “y”", for a suggestion. */
function describeSuggestion(root: CommentRecord): string {
  const exact = clipPassage(root.target?.quote.exact ?? "");
  const replacement = clipPassage(root.suggestion?.replacement ?? "");
  if (exact && replacement) return t({ message: `Replace “${exact}” with “${replacement}”` });
  if (exact) return t({ message: `Delete “${exact}”` });
  return t({ message: `Insert “${replacement}”` });
}

/** A suggested edit as it will read: the text taken out, struck through, and the text put in. */
function Suggestion({ root }: { root: CommentRecord }) {
  const exact = root.target?.quote.exact ?? "";
  const replacement = root.suggestion?.replacement ?? "";
  return (
    <span className="mdbase-thread-suggestion" aria-label={describeSuggestion(root)}>
      <span aria-hidden="true">
        {exact && <del>{clipPassage(exact)}</del>}
        {exact && replacement && " "}
        {replacement && <ins>{clipPassage(replacement)}</ins>}
      </span>
    </span>
  );
}

function Comment({ comment, people, reply, children }: { comment: CommentRecord; people: CommentPeople; reply?: boolean; children?: ReactNode }) {
  const author = personName(comment.createdBy, people) ?? t({ message: "Unsigned" });
  return (
    <div className={`mdbase-comment${reply ? " is-reply" : ""}`}>
      <p className="mdbase-comment-meta">
        <strong>{author}</strong> <time dateTime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString(i18n.locale)}>{when(comment.createdAt)}</time>
        {children}
      </p>
      {comment.deletedAt ? <p className="mdbase-comment-withdrawn">{t({ message: "Withdrawn." })}</p> : comment.text ? <p className="mdbase-comment-text"><InlineText text={comment.text} /></p> : null}
    </div>
  );
}

/** "3 open comments", for a control that opens them. */
export function openCommentCount(threads: readonly PlacedThread[]): string {
  const count = threads.filter((p) => p.thread.root.status === "open").length;
  return plural(count, { one: "# open comment", other: "# open comments" });
}
