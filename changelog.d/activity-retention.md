## Fixed

- The connector's local application activity log no longer grows without
  bound: it keeps the newest 10,000 entries, pruning older ones as new
  entries are recorded (at most 1,000 per entry, so a large existing log
  shrinks gradually). Listing activity reads the newest entries directly
  instead of sorting the whole log. No registry migration is required.
