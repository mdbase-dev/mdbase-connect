## Fixed

- After updating from mdbase Connect, the desktop app and `mdbase doctor` now say
  that collections are waiting for this computer to sign in (or for the mdbase
  server to be reachable), instead of waiting for an account upgrade or a
  migration batch. The portal's sign-in page no longer calls an already-used
  computer a "New computer".
- The takeover is recorded in Activity for each collection that moved, and App
  access explains that apps used with mdbase Connect reappear once Private sync
  is on for the moved collections.
- When turning on sync fails, the reason is shown inside the dialog in plain
  words, and the dialog stays open to retry.
- `mdbase doctor` reports a build without trust for synced collections and no
  longer recommends `mdbase sync enable` when that cannot work.
