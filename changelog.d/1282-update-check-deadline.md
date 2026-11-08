## Fixed

- Desktop update checks now fail within one 60-second deadline, including stalled signature verification, and can be retried after the network recovers without restarting the app. Downloading and staging a verified release has its own 15-minute deadline. Timed-out checks never enable installation or replace a later check's status.
