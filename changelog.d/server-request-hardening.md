## Security

- Refuse a P-256 public key whose base64url text is not the canonical encoding of its bytes. Application authorization requests with such a key now get a 400 `invalid_application_authorization` response instead of a server error.
