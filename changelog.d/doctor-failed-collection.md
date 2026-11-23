## Fixed

- `mdbase doctor` no longer reports a failed collection as `[ok]`. A collection that failed (for example after a sync consistency check) is now a failure, and one that is unavailable a warning, each with the collection's own guidance, such as when mdbase reopens it and how to retry now.
