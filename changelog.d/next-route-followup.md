## Changed

- mdbase-next routing returns only devices of the account that granted the app,
  always uses `wss:` outside loopback development, and orders targets by online
  status, daemon preference, then recent activity. `online` is a read-only hint from
  the current device-bound relay owner, not a recent policy acknowledgement or
  authorization proof. Local routing still has one desktop/CLI device; mobile
  registration is not added. The app collection list leaves out hosted collections
  that are not active or are quarantined.
