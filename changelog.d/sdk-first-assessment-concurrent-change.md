## Fixed

- SDK: a collection whose first readiness check met a concurrent change (for
  example a page adopting a collection another page has open) no longer reads
  `blocked` with `application_readiness_unavailable` until the next select.
  The other readiness checks now run while the interrupted one re-checks, and
  the collection stays opening until it is ready.
