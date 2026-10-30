## Fixed

- A second mdbase account can now sign in on a computer that another account already used. Each account gets its own device on that computer, and new devices still need the usual approval for Private collections. One account can never use another account's device.
- A computer that was removed from an account can sign in again. The removed device stays removed: the computer registers as a new device, keeps its collections that live only on this computer, and Private collections need approval again as for any new device.
- When mdbase cannot register a computer, the app and `mdbase status` now say so, and mdbase keeps trying while it runs instead of giving up until a restart.
- A sign-in left over from an interrupted sign-out no longer stops mdbase from connecting after signing in again.
