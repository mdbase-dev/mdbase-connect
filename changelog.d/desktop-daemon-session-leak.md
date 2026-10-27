## Fixed

- The desktop app keeps a single connection to the mdbase daemon. It previously opened a new status subscription before every daemon request, and on every failed attempt, without closing the old one, so an open window exhausted the daemon's file descriptors within about an hour and the daemon stopped answering.
- The daemon builds its status once per change and shares it with every connected app, instead of rebuilding it, including a scan of every synced record, once per connection. A collection that is slow to report no longer holds up status for the others: after 2 seconds it is reported without its live sync counters.
