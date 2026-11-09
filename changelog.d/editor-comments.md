## Added

- Editor: read and answer comments on any note in a collection that has a comment type (`mdbase.comment`). Commented passages are highlighted in the text; the Comments inspector lists the note's threads, and you can comment on a selection (Ctrl/Cmd+Alt+M) or the whole note, reply, resolve, reopen, withdraw, and accept or reject suggested edits made in other apps. Comments stay ordinary records in the collection.
- Shared UI: `@mdbase-dev/ui/comments`, `/comments-panel`, `/comment-anchors` and `comments.css` hold the comment contract's reading, thread panel and CodeMirror anchors for every app. The Editor uses a vendored build of the package until this version is published.
