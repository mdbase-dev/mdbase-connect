## Added

- Behind the next control-plane flag, serve `GET /v1/next/rollout` to connector credentials: `local_takeover` is true only for an account already on the next backend, the response names only the caller's own backend, and it is never cached. Anonymous, session, app installation, revoked and suspended callers get 401.
