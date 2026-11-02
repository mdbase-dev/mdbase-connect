## Fixed

- The daemon's log transport now reconnects at once when its token is renewed every 15 minutes, instead of treating renewal as a failure with a one-second offline backoff and an info line per collection.
- Log transport reconnect lines now name the collection, and a hello proof that the collection runtime did not answer in time is no longer reported as the replica refusing it.
- A refused policy snapshot now logs why and how old it was, and a lease that expired while waiting to be applied is reported apart from a malformed one.
