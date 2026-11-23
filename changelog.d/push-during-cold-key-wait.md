## Fixed

- Open the log push WebSocket before the cold verified read in browser app
  collections (`createAppWebCollectionAdapter`) and wake the cold read loop
  when a push frame is accepted, so a late collection key grant announced over
  push triggers a re-probe within about a second instead of waiting for the
  next doubling backoff step. Socket failures and push auth refusals during
  the cold open continue to fall back to the backoff without failing or
  slowing the open.
