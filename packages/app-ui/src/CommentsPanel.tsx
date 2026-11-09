// The comments on one record: threads in reading order, with replies,
// resolving, and suggested edits to accept or reject. A new comment starts
// from a passage the app hands in (`pending`). Style with
// `@mdbase-dev/ui/comments.css`.
import { plural, t } from "@lingui/core/macro";
import { memo, useEffect, useRef, useState, type JSX, type ReactNode } from "react";

import {
  clipPassage,
  inlinePieces,
  personName,
  plainPassage,
  when as relativeTime,
  writtenByMe,
  type CommentChange,
  type CommentPeople,
  type CommentRecord,
  type CommentThread,
  type PlacedThread,
} from "./comments.js";
import { i18n, useLocaleRevision } from "./i18n.js";

const when = (iso: string) => relativeTime(iso, i18n.locale);

/** What a write came to; a failure's message is shown beside the action that made it. */
export type CommentResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** A comment being written: on `quote`, at a point in the text (an empty quote), or on the whole record. */
export interface PendingComment {
  readonly quote?: string;
}

type Filter = "open" | "resolved";

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
  readonly onSubmit: (text: string) => Promise<CommentResult>;
  readonly onCancel: () => void;
  readonly onReply?: ((thread: CommentThread, text: string) => Promise<CommentResult>) | undefined;
  readonly onChange?: ((comment: CommentRecord, change: CommentChange) => Promise<CommentResult>) | undefined;
  /** Makes a suggested edit and resolves its thread. */
  readonly onAccept?: ((placed: PlacedThread) => Promise<CommentResult>) | undefined;
  /** Opens a comment's own record. */
  readonly onOpenRecord?: ((path: string) => void) | undefined;
}

export function CommentsPanel({ threads, people, loading = false, problem, onRetry, active, pending, onStart, hint, notice, onSelect, onSubmit, onCancel, onReply, onChange, onAccept, onOpenRecord }: CommentsPanelProps): JSX.Element {
  useLocaleRevision();
  const [filter, setFilter] = useState<Filter>("open");
  const panel = useRef<HTMLElement>(null);
  const groups = { open: threads.filter((p) => p.thread.root.status === "open"), resolved: threads.filter((p) => p.thread.root.status === "resolved") };
  const shown = groups[filter];

  // A thread selected in the editor comes into view (and shows, even when resolved).
  useEffect(() => {
    if (!active) return;
    const hit = threads.find((p) => p.thread.root.path === active);
    if (hit) setFilter(hit.thread.root.status);
    const frame = requestAnimationFrame(() => panel.current?.querySelector(`[data-thread="${CSS.escape(active)}"]`)?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new selection moves the list
  }, [active]);

  return (
    <section ref={panel} className="mdbase-comments" aria-label={t({ message: "Comments" })}>
      <div className="mdbase-comments-bar">
        <div className="mdbase-comments-filter" role="group" aria-label={t({ message: "Show" })}>
          {(["open", "resolved"] as const).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === "open" ? t({ message: "Open", context: "Comment status" }) : t({ message: "Resolved", context: "Comment status" })} <span className="mdbase-comments-count">{groups[f].length}</span>
            </button>
          ))}
        </div>
        {onStart && <button type="button" className="mdbase-button" onClick={onStart} disabled={pending !== null}>{t({ message: "New comment" })}</button>}
      </div>
      {notice}
      {pending && <Composer key={pending.quote ?? "\0whole"} pending={pending} signer={people.signing?.kind === "linked" ? people.me?.name : undefined} onSubmit={onSubmit} onCancel={onCancel} />}
      {loading && <p className="mdbase-comments-note" role="status">{t({ message: "Loading comments…" })}</p>}
      {problem && <p className="mdbase-comments-note">{t({ message: `Comments could not be loaded: ${problem}` })} {onRetry && <button type="button" className="mdbase-thread-action" onClick={onRetry}>{t({ message: "Try again" })}</button>}</p>}
      {!loading && !problem && !shown.length && !pending && (
        <div className="mdbase-comments-empty">
          {filter === "open" ? <><p><strong>{t({ message: "No open comments" })}</strong></p>{hint && <p>{hint}</p>}</> : <p>{t({ message: "Nothing resolved yet." })}</p>}
        </div>
      )}
      <ul className="mdbase-threads">
        {shown.map((p) => (
          <Thread key={p.thread.root.path} placed={p} people={people} active={p.thread.root.path === active} onSelect={onSelect} onReply={onReply} onChange={onChange} onAccept={onAccept} onOpenRecord={onOpenRecord} />
        ))}
      </ul>
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

function Composer({ pending, signer, onSubmit, onCancel }: { pending: PendingComment; signer: string | undefined; onSubmit(text: string): Promise<CommentResult>; onCancel(): void }) {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const { busy, error, run } = useAction();
  useEffect(() => field.current?.focus(), []);
  const empty = !text.trim();
  const submit = () => void run(() => onSubmit(text));
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
        <strong>{t({ message: "New comment" })}</strong>
        {signer && <span>{t({ message: `as ${signer}` })}</span>}
      </p>
      {pending.quote
        ? <blockquote className="mdbase-thread-quote">{plainPassage(pending.quote)}</blockquote>
        : <p className="mdbase-thread-whole">{pending.quote === "" ? t({ message: "At the cursor" }) : t({ message: "On the whole note" })}</p>}
      <textarea ref={field} className="mdbase-field" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={t({ message: "Comment" })} aria-label={t({ message: "Comment" })} />
      {error && <p className="mdbase-comments-error" role="alert">{error}</p>}
      <div className="mdbase-thread-actions">
        <button type="submit" className="mdbase-button is-primary" disabled={busy || empty}>{t({ message: "Comment" })}</button>
        <button type="button" className="mdbase-button" onClick={onCancel} disabled={busy}>{t({ message: "Cancel" })}</button>
      </div>
    </form>
  );
}

const Thread = memo(function Thread({ placed, people, active, onSelect, onReply, onChange, onAccept, onOpenRecord }: {
  placed: PlacedThread;
  people: CommentPeople;
  active: boolean;
} & Pick<CommentsPanelProps, "onSelect" | "onReply" | "onChange" | "onAccept" | "onOpenRecord">) {
  const { thread, at } = placed;
  const { root } = thread;
  const [reply, setReply] = useState("");
  const [replying, setReplying] = useState(false);
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
      <button type="button" className="mdbase-thread-anchor" onClick={() => onSelect(placed)} title={at === null ? t({ message: "This passage is no longer in the text" }) : t({ message: "Show in the note" })}>
        {suggestion ? <Suggestion root={root} /> : root.target
          ? <blockquote className="mdbase-thread-quote">{plainPassage(root.target.quote.exact) || t({ message: "(a point in the text)" })}</blockquote>
          : <span className="mdbase-thread-whole">{t({ message: "On the whole note" })}</span>}
        {at === null && <span className="mdbase-thread-detached">{t({ message: "The text it was on has changed" })}</span>}
      </button>
      <Comment comment={root} people={people} />
      {thread.replies.map((r) => <Comment key={r.path} comment={r} people={people} reply>{withdraw(r)}</Comment>)}
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
