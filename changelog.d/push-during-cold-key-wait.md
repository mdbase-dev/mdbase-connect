## Fixed

- Open the log push WebSocket before the cold verified read in browser app
  collections (`createAppWebCollectionAdapter`) and wake the cold read loop
  when a push frame is accepted, so a late collection key grant announced over
  push triggers a re-probe within about a second instead of waiting for the
  next doubling backoff step. Transient socket failures during the cold open
  fall back to the backoff and reconnect normally without failing or slowing
  the open, and any terminal push access-ended notice is recorded and surfaced
  once the open completes.
