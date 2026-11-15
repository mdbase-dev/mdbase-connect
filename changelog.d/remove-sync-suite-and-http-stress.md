## Removed

- The `sync` system suite (`pnpm e2e:sync`) and its Server CI shard. It ran the legacy sync protocol against the development-only reference authority, which no deployment can enable; the provider suite covers the same client against the real hosted provider.
- The HTTP mode of the functional stress runner (`pnpm stress:http`, `--transport`). The stress profiles now run only against the in-memory authority, and regression fixtures no longer carry a `transport` field.
