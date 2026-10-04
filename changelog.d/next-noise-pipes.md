## Added

- With `MDBASE_NEXT_CONTROL_PLANE=1`, the relay carries mdbase-next Noise sessions
  between apps and daemons (`GET /v1/next/relay/client` and `noise_pipe_v1` on the
  connector socket). The relay forwards opaque bytes, routes only to the named
  device's currently bound socket and checks the device's registered Noise key. It
  works across instances through the relay broker.
- An open relay pipe re-checks its app token and grant every 30 seconds and closes at
  both ends once either is revoked, as a backstop to the daemon's own revocation.
  It also closes when authorization cannot be revalidated.
