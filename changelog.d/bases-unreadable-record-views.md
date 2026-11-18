## Fixed

- One note whose frontmatter cannot be read (for example, not a YAML mapping) no
  longer stops every Bases view in the collection from loading. Views skip that
  record and still read every other record, whether its change has synced or
  is still pending. Before, the raw view projection was left unready and each
  view refused with `view_raw_projection_not_ready`. Existing app and computer
  stores rebuild the projection once, on their next open after the update.
