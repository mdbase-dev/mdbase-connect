## Security

- Refuse a P-256 public key whose base64url text is not the canonical encoding of its bytes. Application authorization requests with such a key now get a 400 `invalid_application_authorization` response instead of a server error.
- An HTTPS deployment reads only the `__Host-mdbase_session` account session cookie it issues and ignores the unprefixed `mdbase_session` name, which remains for plain-HTTP loopback development servers. Every session issued before the prefixed cookie was introduced expired in August 2026.
- Send `Cache-Control: no-store` on `GET /v1/me`, matching the other account endpoints.
