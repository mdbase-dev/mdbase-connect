# Local app development

An application is developed on a loopback HTTP origin against the same Connect
environment it will ship to. There is no development flag, allowlist entry or
separate SDK package for it.

## The rule

A loopback HTTP web origin (`http://localhost:<port>`, `http://127.0.0.1:<port>`
or `http://[::1]:<port>`) is an admissible **application** origin in every
environment: LAB, staging and production. Connect's own origins (control plane,
log, portal) stay HTTPS outside LAB and isolated local builds. No other
plain-HTTP origin is an application origin anywhere.

| Check | Where | Loopback application origin |
|---|---|---|
| Declaration `origin`, storage, asset and return-URL checks | SDK (`app-origin.ts`, `return-url.ts`) | Accepted in every environment |
| Control-plane and log origins | SDK (`selectAppEnvironment`, `serviceLoopbackAllowed`) | HTTPS only outside LAB/local builds |
| Manifest `homepage` and `redirect_uris` | `POST /v1/apps/register`, `POST /v1/apps/validate` | Accepted |
| Installation pairing START | `installationApp` | Accepted when the origin is the one the manifest's homepage or redirect URIs declare, for an app runtime |
| Loopback origin listed only under `installation_origins` | `installationApp` | Refused in staging and production, as before |
| Approval screen | portal `RequestIdentity` | "an app running on this computer", identity unverified, no icon |

`@mdbase-dev/connect-dev validate-manifest` stays strict by default so a
production manifest with a loopback homepage is caught before it ships; pass
`--allow-local` for the development manifest.

## What a developer does

Keep two manifests: the published one with the HTTPS homepage, and a
development one whose `homepage` and `redirect_uris` use the dev server's
origin. Pass the matching one to `createMdbase`, with `environment:
"production"` in both cases. The two are separate registered applications
(different canonical identity, the same family identity when they share an ID),
so collection approvals and device storage made on localhost stay on localhost.

## Development servers

A development server serves the SDK's modules from `node_modules` with a
cache-busting query (`vite dev` adds `?v=<hash>`). The SDK used to refuse to
select its packaged WebAssembly files from a module URL with a query, which
surfaced as "The app couldn't load" (`application_packaged_assets_unavailable`)
for every app that installed the SDK from npm; first-party apps link the
workspace package and never met it. The module URL's query is now ignored: the
files resolve beside the module without it, on the app's origin, and their bytes
are still checked against the packaged pins. `vite dev` and `vite build` both
work with Vite's default configuration.

## Why this is safe

- A remote page cannot give itself a loopback origin. The browser sets `Origin`,
  and requesting or framing a loopback URL does not transfer that origin or its
  storage. The party that can serve a loopback origin is a program already
  running on the person's computer.
- Production already accepted `http://127.0.0.1:<port>` for manifests that
  declare `platform: "native"` (see [native app platform](native-app-platform.md)).
  This extends the same admission to `localhost` and `[::1]` and to web
  declarations, and requires the origin to be the one the manifest declares.
- Registration was already open to any HTTPS origin and identifies no
  publisher. A loopback declaration gains nothing an HTTPS lookalike could not
  already register, and unlike one it cannot be reached by a link.
- The approval screen never shows a loopback application's name or icon as
  branding. Account approval, collection consent and per-collection capability
  grants are unchanged, and each grant is bound to the exact origin and port.
- Account-origin cookie privileges and CORS credentials are decided by the
  configured account origins and are unaffected.

## Removed

`MDBASE_CONNECT_ALLOW_INSECURE_MANIFESTS` no longer exists; the server ignores
it. The SDK's storage modules no longer take `allowLoopbackHttp` or
`allowNativeLoopbackHttp`, and `selectAppEnvironment` no longer takes
`platform`: an application origin is admitted by one rule. `allowLoopbackHttp`
remains only where it relaxes HTTPS for Connect's own origins in LAB.
