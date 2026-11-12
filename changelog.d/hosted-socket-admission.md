## Security

- Keep cloud copy app connections available when other connections never finish signing in: at the per-collection connection limit, the oldest connection that has not signed in is closed to admit a new one, and the session limit now counts only signed-in sessions.
- Limit unsubscribe, stream leave and stream send requests on the log service to collections the connection has already joined.
- Close native log server connections when their access token expires, with the same `expired` close code the hosted log service uses, so clients reconnect with a fresh token.
