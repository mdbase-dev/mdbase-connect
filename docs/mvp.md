# MVP acceptance path

The MVP is complete when a user can:

1. Install mdbase connect and launch it automatically at login.
2. Create a v0.3 collection or register an existing one.
3. Pair the connector through a signed-in browser without copying a token.
4. Open an unrelated application that bundles an mdbase app declaration.
5. See the pending request in the local controller, choose a collection, and
   approve exact operations and its contract-derived record scope there.
6. Discover its schemas and optional domain contracts without exposing its
   filesystem path.
7. Read, query, and conditionally update records through the relay while records
   outside the approved contract remain inaccessible.
8. Receive resumable, content-free change notifications after local or remote
   writes.
9. Pause remote access locally and observe requests fail without removing the
   grant.
10. Resume, revoke access locally, and observe the next request fail.
11. Review allowed and denied requests in the local activity log.
12. Close the desktop window while the tray connector continues running.
13. Retain the connection across browser restarts and access-token renewal
    without repeating approval, until the grant is revoked.
14. Keep operation inputs and results encrypted between the authorized
    application installation and the local connector, and reject replay,
    tampering, or plaintext fallback.

The TaskNotes reference app proves that an independent frontend can follow a
configurable domain contract. Hosted collections, file mirroring, a developer
portal, an app marketplace, multi-user sharing, billing, and fine-grained field
permissions remain outside this milestone.
