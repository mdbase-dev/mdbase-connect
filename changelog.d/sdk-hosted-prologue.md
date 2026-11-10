## Fixed

- `relayConnector` sends the client prologue in clear before Noise message 1 on a hosted replica route (`RelayRoute.prologueFirst`, set by `routeFromControl` for hosted targets); the hosted replica closes a session that starts without it.
