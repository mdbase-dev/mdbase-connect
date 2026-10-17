## Fixed

- The hosted provider no longer restarts a semantic projection rebuild from scratch when records are written while it runs: a completed rebuild replays up to 64 changed records through write-path maintenance and activates at the current head. Rebuild batches also stop after about one second, so record writes, notification recovery and the migration fence no longer hit the 5 s lock timeout while a large collection is being indexed.
