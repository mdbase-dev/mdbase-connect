# SDK: classic-script browser bundle

`npm run build` includes `dist/browser/mdbase-sdk.js` and
`dist/browser/mdbase-sdk.min.js` in the SDK archive. Serve the exact qualified
archive's asset from your app's origin; no CDN publication is implied.

```html
<script src="./vendor/mdbase-sdk.min.js"></script>
<script>
  const { connect, Client, AppHost } = window.MdbaseSDK;
  // Root exports match @mdbase-dev/sdk; Client groups client.ts exports.
  // AppHost matches @mdbase-dev/sdk/app-host.
</script>
```

Module consumers can import the same surface from `@mdbase-dev/sdk/browser`.
There is no `MdbaseConnect` compatibility shim or app-specific adapter. Loading
this bundle does not create a session, open storage, load a WASM runtime or grant
access. App-host APIs still require explicit qualified app/environment trust,
runtime, origin and custody inputs. This package does not supply a complete web
Worker/session/runtime composition; use the shared SDK composition when available,
not an app-specific substitute. Packaging tests are not sign-in, CRUD, custody,
physical durability or release-qualification evidence.
