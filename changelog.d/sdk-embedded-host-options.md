## Added

- SDK: two options for an app that runs the SDK inside another app's document,
  such as a `blob:` iframe in a mobile WebView. `urlSelection: false` keeps the
  selected collection out of the page URL, so the app selects with `select`,
  `approve` and `clearSelection`, and a `blob:` document no longer fails with
  `application_selection_binding`. `worker: url => Worker` lets the host
  construct the SDK's module Worker (for example from a `blob:` URL of
  `worker.js`); the Worker still loads its native assets from beside `url` and
  checks them against the SDK's pins. Both default to the existing behaviour.
