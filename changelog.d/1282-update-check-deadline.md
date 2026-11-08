## Fixed

- Desktop update checks now fail within one 60-second deadline, including stalled signature verification, and can be retried after the network recovers without restarting the app. Timed-out checks never enable installation or replace a later check's status.
