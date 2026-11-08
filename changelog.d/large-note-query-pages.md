## Fixed

- Return a note whose stored size alone exceeds the 1 MiB per-request query
  budget on a page of its own, instead of refusing the page with `too_large`. A
  note near the 1 MiB document limit could be written but then broke note
  listing and manuscript opening in Writer and Editor until it was deleted.
- Page query results while local edits are pending, as without them. Before,
  any pending edit made a listing over 1 MiB fail with `too_large` until the
  edit was confirmed. A page needs its limit plus the pending edits to stay
  within 1000 records (more than 500 pending edits at Writer's page size of
  500); beyond that the query takes the per-record path, which still refuses
  over 1 MiB on memory-constrained and hosted replicas.
