## Fixed

- Prevent deadlocks between hosted projection batch persistence and concurrent projection startup by acquiring collection locks before generation locks.
