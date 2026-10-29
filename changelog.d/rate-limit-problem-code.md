## Fixed

- Report collection join throttling as retryable `rate_limited` errors instead of `invalid_request` / `sync_refused`, preserving the server's retry delay. Fastify rate limits now use the same canonical problem shape across routes.
