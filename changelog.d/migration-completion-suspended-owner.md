## Fixed

- The migration job's completion readback accepts a suspended owner whose migration completed, so suspended accounts no longer stop at `verify_completion` with `lab_completion_missing`. Sharing, timers and every other post-migration guard still refuse suspended owners.
