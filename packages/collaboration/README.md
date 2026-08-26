# @mdbase-dev/connect-collaboration

Optional Yjs profile adapter for mdbase real-time record collaboration.

This private package is intentionally separate from `@mdbase-dev/connect` so
ordinary collection clients do not load Yjs. It is the sole shared owner of the
experimental hosted Yjs/WebSocket protocol; the public client SDK exposes no
collaboration protocol or ticket API.

The public mdbase record remains ordinary Markdown. Profile v1 owns exactly
`Y.Text("body")`, preserves the authority-visible body string without Unicode
normalization, and accepts LF line endings only.

`openExperimentalHostedMarkdownRoom(connection, options)` discovers the private
symbol bridge installed by a hosted connection and returns semantic room state,
a `Y.Doc`, `Y.Text("body")`, and `Y.UndoManager`. It owns ticket refresh,
authentication frames, state-vector synchronization, acknowledgements,
reconnect, heartbeat, awareness replacement, bounds enforcement, and cleanup.
The API is experimental and remains available only from this private workspace
package.
