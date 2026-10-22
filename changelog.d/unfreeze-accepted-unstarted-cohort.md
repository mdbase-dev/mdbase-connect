## Fixed

- A zero-hosted migration cohort whose archive was accepted but which no member ever started can be unfrozen and rerun. Unfreeze advances the cohort's membership revision, so the old acceptance is kept but is no longer current; the rerun freezes, archives and is accepted again. Unfreeze is still refused once any member has started.
