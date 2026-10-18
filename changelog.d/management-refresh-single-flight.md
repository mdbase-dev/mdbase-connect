## Fixed

- Keep portal management reads single-flight so slow account loading is not continually superseded by background refreshes. Unavailable initial reads can be retried without signing in again; completed mutations still get a fresh post-operation snapshot.
