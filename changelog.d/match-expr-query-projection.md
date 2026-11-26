## Fixed

- A collection with a type matched by `match.expr` now builds its query and
  raw view projections. Before, the whole projection was switched off for
  such a collection, so every Bases view refused with
  `view_raw_projection_not_ready` and searches used the slower per-record
  path. Existing stores build the projections on their next open after the
  update.
- `mdbase access list` no longer fails with "frame of … bytes exceeds
  1048576" when several app grants carry a large stored setup. The list
  leaves out that setup, which it never showed.
