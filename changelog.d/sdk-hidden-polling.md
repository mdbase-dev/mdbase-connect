## Changed

- `watch`, and the `observe` and `connection.watch` APIs built on it, now poll
  for changes at most once a minute while the browser page is hidden, and poll
  immediately when it becomes visible again. Outside browsers, and in visible
  pages, the requested `pollIntervalMs` is unchanged.
