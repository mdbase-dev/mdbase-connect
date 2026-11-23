## Fixed

- Preserve relay pipe refusal reasons in a `pipe_close` text frame before closing the WebSocket, and map `relay_closed` / `pipe_closed` to retryable unavailable copy in the SDK instead of a generic error.
- Report a computer's currently serving collections on its relay connection so Connect detects when an online computer is not serving a Private collection (such as after removing it locally) and refuses unregistered collections with `not_served`.
