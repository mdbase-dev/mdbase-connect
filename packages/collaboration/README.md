# @mdbase-dev/connect-collaboration

Optional Yjs profile adapter for mdbase real-time record collaboration.

This package is intentionally separate from `@mdbase-dev/connect` so ordinary
collection clients do not load Yjs. During Phase 0 it contains only the pinned
`markdown-body-yjs-v13` profile contract and executable interoperability proofs.
Provider-neutral room APIs and reconnect behavior will be added after the
versioned capability contract is accepted.

The public mdbase record remains ordinary Markdown. Profile v1 owns exactly
`Y.Text("body")`, preserves the authority-visible body string without Unicode
normalization, and initially accepts LF line endings only.
