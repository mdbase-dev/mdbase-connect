## Fixed

- Return a note whose stored size alone exceeds the 1 MiB per-request query
  budget on a page of its own, instead of refusing the page with `too_large`. A
  note near the 1 MiB document limit could be written but then broke note
  listing and manuscript opening in Writer and Editor until it was deleted.
- Page query results while local edits are pending, as without them. Before,
  any pending edit made a listing over 1 MiB fail with `too_large` until the
  edit was confirmed, including while offline.
