## Fixed

- Refused writes to collections on read-only volumes (`ReplaceStrategy::ReadOnly`, such as volumes without atomic file replacement) with `forbidden` / `read_only_volume` instead of committing unpublished changes to the local index, stopped infinite publish retries on `"read_only"` drifts, and reported `IncidentKind::ReadOnly` on open.
