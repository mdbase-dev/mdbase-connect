## Fixed

- Shared dialogs release modal focus immediately while an inert visual exit waits for actual animation completion; backdrop presses preserve the current selection, and palettes reset their query before paint.
- Collection gates own one page landmark, use consecutive setup headings in pages and embedded panels, and replace an unavailable Add action with one quota notice that clears when the collection count changes.
- App links use consumer-supplied deployment URLs without silently falling back to production. Portal discovers Editor, Reader and Writer from its runtime managed-environment configuration, including LAB and staging; unconfigured custom apps are omitted.
