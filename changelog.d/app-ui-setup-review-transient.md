## Fixed

- `@mdbase-dev/ui/collections`: the setup review plans again by itself, with
  backoff, while the SDK reports a transient refusal (for example another tab
  finishing setup), instead of stopping at "Try again".
