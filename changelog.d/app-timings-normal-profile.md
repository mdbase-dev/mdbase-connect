## Changed

- The daily app timings open each app in a fresh on-disk browser profile instead of an off-the-record context, whose in-memory app storage made cold opens several times slower than people see. Cold-open timings step down from this change.
