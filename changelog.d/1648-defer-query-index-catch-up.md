## Changed

- A device installing a snapshot of a collection now builds its query index once, after it has applied the entries that followed the snapshot, instead of after the snapshot and again after each type change among those entries. A query that arrives before then builds the index first.
