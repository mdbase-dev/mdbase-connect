## Added

- SDK: the `session` option puts separately bundled contexts of one app, such as a browser extension's pages, offscreen document and service worker, in one session. `session: { build }` names the app's build, and contexts of the origin with the same name share one sign-in and one Worker. `host: false` marks a context that never runs the Worker: it joins the context that does and waits while there is none, so the SDK now works in a service worker. See `docs/sdk-shared-session.md`.
