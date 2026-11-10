import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import type { CommentPeople, CommentRecord, CommentThread } from "@mdbase-dev/ui/comments";
import { CommentsPanel } from "@mdbase-dev/ui/comments-panel";
import { XIcon as X } from "./icons";
import type { NoteComments } from "./use-note-comments";

/** The open note's comment threads, in the inspector. */
export function NoteCommentsPanel({ title, comments, onOpenRecord, onOpenSettings, onClose }: {
  title: string;
  comments: NoteComments;
  onOpenRecord: (path: string) => void;
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const { canWrite } = comments;
  useLingui();
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘⌥M" : "Ctrl+Alt+M";
  return <aside className="properties-panel comments-panel" aria-label={t`Comments`}>
    <header className="panel-header">
      <div><h2><Trans>Comments</Trans></h2><p>{title}</p></div>
      <button className="icon-button" aria-label={t`Close comments`} data-inspector-close onClick={onClose}><X aria-hidden="true" /></button>
    </header>
    <div className="comments-panel-body">
      <CommentsPanel
        threads={comments.threads}
        people={comments.people}
        loading={comments.loading}
        problem={comments.problem}
        onRetry={comments.retry}
        active={comments.active}
        pending={comments.pending}
        onStart={canWrite ? comments.start : undefined}
        hint={canWrite ? <Trans>Select a passage and press <kbd>{mod}</kbd> to comment on it.</Trans> : undefined}
        notice={canWrite ? <Signing people={comments.people} onCheck={comments.checkAccount} onOpenSettings={onOpenSettings} /> : undefined}
        onSelect={comments.select}
        onSubmit={comments.submit}
        onCancel={comments.cancel}
        onReply={canWrite ? (thread: CommentThread, text: string) => comments.reply(thread, text) : undefined}
        onChange={canWrite ? (comment: CommentRecord, change) => comments.change(comment, change) : undefined}
        onAccept={canWrite ? comments.accept : undefined}
        onOpenRecord={onOpenRecord}
      />
    </div>
  </aside>;
}

/**
 * Why new comments will not be signed, and where to put that right: an
 * account is linked to its person record in Settings.
 */
function Signing({ people, onCheck, onOpenSettings }: { people: CommentPeople; onCheck: () => void; onOpenSettings: () => void }) {
  const { signing } = people;
  if (!signing || signing.kind === "linked") return null;
  const why = signing.kind === "unlinked" ? t`Your account is not linked to a person in this collection.`
    : signing.kind === "conflict" ? (signing.paths.length > 1
      ? t`More than one person record claims your account, so the editor will not guess which is you.`
      : t`The person record that claims your account is not valid.`)
    : signing.kind === "not-approved" ? t`The editor was not allowed to see your account for this collection.`
    : t`Your account could not be checked (${signing.reason}).`;
  return <div className="mdbase-comments-signing" role="status">
    <p><strong><Trans>Your comments will not be signed.</Trans></strong> {why}</p>
    <div className="mdbase-thread-actions">
      {signing.kind !== "unavailable" && <button type="button" className="mdbase-thread-action" onClick={onOpenSettings}><Trans>Open Settings</Trans></button>}
      <button type="button" className="mdbase-thread-action" onClick={onCheck}><Trans>Check again</Trans></button>
    </div>
  </div>;
}
