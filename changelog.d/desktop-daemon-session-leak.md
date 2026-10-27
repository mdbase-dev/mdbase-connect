## Fixed

- The desktop app keeps a single connection to the mdbase daemon. It previously opened a new status subscription before every daemon request, and on every failed attempt, without closing the old one, so an open window exhausted the daemon's file descriptors within about an hour and the daemon stopped answering.
