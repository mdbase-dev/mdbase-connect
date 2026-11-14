## Fixed

- Keep record-session drafts editable after definite save refusals, including
  validation and permission errors, instead of waiting for a nonexistent mutation.
  Concurrent revision conflicts expose the current record for explicit resolution;
  release/reopen retains the unsaved draft. Uncertain write outcomes continue to
  recover under their original mutation identity.
