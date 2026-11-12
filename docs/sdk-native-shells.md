# SDK: native shells and browser extensions

A Capacitor app declares its native origin (for example
`capacitor://app.tasknotes.dev`) as `origin`, and lists it in the manifest under
`installation_origins.<environment>.mobile`. Pairing then uses installation kind
`mobile`. `capacitor://` origins default to that kind; an Android shell served
from https sets `installationKind: "mobile"`. A Chrome extension uses its
`chrome-extension://<id>` origin under `installation_origins.<environment>.app-runtime`.
Firefox `moz-extension://` origins differ per profile and are not accepted by
Connect.

Where a popup is unavailable, pass a sign-in opener:

```ts
const mdbase = createMdbase(declaration, {
  signIn: {
    open: url => Browser.open({ url }),            // or chrome.tabs.create({ url })
    close: () => Browser.close(),
    returnUrl: "dev.tasknotes.app://auth/mdbase/callback", // optional; see below
  },
  followVisibility: true, // re-poll as soon as the app returns to the foreground
});
```

`returnUrl` must exactly equal one of the manifest's `redirect_uris`, or
`createMdbase` throws `application_sign_in_opener`. That is either an https URL on
the homepage origin or, for a native app, a private-use scheme derived from the
manifest ID (RFC 8252), such as `dev.tasknotes.app://auth/mdbase/callback` for
ID `dev.tasknotes.app`. No prefix or wildcard matching. Connect applies the same
exact match before it returns the user there. The URL carries no credential:
sign-in still completes by the SDK's pairing poll.

The SDK still binds the URL to the environment's Connect origin. The pending
pairing request is persisted, so a context that closes during sign-in (an
extension popup) resumes it on the next `start()`. Run extension sign-in from a
side panel or tab page where possible. Without `followVisibility`, call
`mdbase.setForeground(active)` from the shell's resume/pause events.

An extension's pages, offscreen document and service worker are bundled
separately. The `session` option puts them in one session with one Worker:
see [`docs/sdk-shared-session.md`](sdk-shared-session.md).

## Running inside another app's document

A host app that runs the SDK in a document without a URL of its own (a `blob:`
iframe inside a mobile WebView, for example) passes two options:

```ts
const workerScript = await (await fetch(sdkWorkerUrl)).text(); // the SDK's own worker.js
const workerBlob = URL.createObjectURL(new Blob([workerScript], { type: "text/javascript" }));
const mdbase = createMdbase(declaration, {
  urlSelection: false,                                        // select with select()/approve()
  worker: url => new Worker(workerBlob, { type: "module" }), // url: where worker.js is served
});
```

- `urlSelection: false`: the SDK never reads or writes the page URL. A link or
  Back/forward no longer selects a collection, and the app selects with
  `select`, `approve` and `chooseAnother`. The last-used collection is still
  remembered on the device. Without it, a `blob:` document reports
  `application_selection_binding`.
- `worker`: the SDK calls it with the URL it would load its module Worker from
  (`worker.js` beside the SDK's entry module). Return a module Worker running
  that script's exact bytes. The Worker loads `runtime.wasm`, `sqlite3.wasm`
  and `sqlite3.js` from `../native/` beside that URL, so serve the SDK's
  `dist/application` and `dist/native` files there; their bytes are still
  checked against the SDK's pins. A factory that throws or returns no Worker
  fails with `application_worker_unavailable`.

Both default to the ordinary behaviour, and a bundler-built app needs neither.
