## Fixed

- Preserve timer declarations and consent throughout application sign-in, approval, exchange, and background notification handling on explicitly local-built servers. Local declarations require the server's own local environment and an exact loopback origin; managed environment checks and registered-origin authorization are unchanged.
- Reject port zero in local loopback origins.
