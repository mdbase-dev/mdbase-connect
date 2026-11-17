## Fixed

- Count consent outcomes correctly in the usage report: a denial is no longer counted as approved, the Native companion authorization each app pairing prepares is no longer counted as an abandoned sign-in, and operators can mark test accounts with `users mark-test` so their activity is left out. The server now logs why it refuses an authorization request.
