# SDK: build environments and localhost

Application declarations support explicit `lab`, `staging` and `production`
environments. Each SDK artifact must be packaged with the completed authenticated
trust handoff for that exact environment; changing an app build variable cannot
retarget a LAB archive. Staging packaging pins Connect to
`https://connect-staging.mdbase.dev`, production to `https://connect.mdbase.dev`.
CP/log origins and release trust still come only from the verified build context;
missing, expired or crossed trust refuses without a fallback. Isolated `local`
builds remain separate and refuse all managed environments.

## Developing on localhost

In every managed environment the app's own `origin` may be a loopback HTTP
origin (`http://localhost:<port>`, `http://127.0.0.1:<port>` or
`http://[::1]:<port>`), so an app is developed against production with the
published package:

```ts
createMdbase({ id, name, origin: "http://localhost:5173", environment: "production", manifest: devManifest });
```

The manifest's `homepage` and `redirect_uris` use that same origin. Connect
registers it as its own application, apart from the one published at the HTTPS
origin: approvals and device storage belong to the exact origin and are not
shared between the two. The approval screen calls it "an app running on this
computer" and says its identity is unverified, as it does for a native app.
Connect's own origins (control plane, log) stay HTTPS outside LAB; no other
plain-HTTP app origin is accepted.

`vite dev` and `vite build` both work with Vite's default configuration: the
SDK's worker and WebAssembly files are served from `node_modules` in
development and emitted as assets in a build.

The app manifest must declare the installation origin under
`installation_origins.staging` for staging pairing, just as for other environments.
Packaging support alone is not an application deployment or acceptance receipt.
