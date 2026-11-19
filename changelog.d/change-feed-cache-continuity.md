## Fixed

- Keep app caches built from the change feed correct: a feed page that ends inside one notification's changes now resumes inside them instead of skipping the rest, and pages keep to their limit, and a type or contract change now resets change watchers and older cursors so caches re-read records whose types changed. A change's `types` now match what a read of the record returns while a definition change is pending.
- `ChangesWatch.cursor` exposes the feed position a watch has delivered up to, so an app that stops a watch (for example when it goes to the background) can resume it with `watchChanges(onChanges, { cursor })` instead of re-reading everything.
