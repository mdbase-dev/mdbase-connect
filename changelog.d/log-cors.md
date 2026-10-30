## Fixed

- Allow log transport from every browser origin with credentialless wildcard CORS, ignoring `LOGSVC_CORS_ORIGINS` and removing Origin-based WebSocket rejection. Bearer tokens, nonce signatures and replay checks are unchanged.
