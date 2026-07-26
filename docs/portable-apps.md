# Portable HTML applications

mdbase Connect v1 supports a single downloaded HTML file without a web origin,
redirect URI, build step, or application backend. This profile remains labelled
v1 while Connect is pre-release.

## Manifest

A portable application bundles its declaration inline:

```json
{
  "manifest_version": 1,
  "distribution": "portable",
  "id": "dev.example.portable-notes",
  "name": "Portable notes",
  "project_url": "https://example.dev/portable-notes",
  "requirements": {
    "access": "full_collection",
    "contracts": []
  }
}
```

`distribution: "portable"` replaces `homepage` and `redirect_uris`.
`project_url` is optional presentation metadata. It must be HTTPS, but it is not
publisher verification or evidence that the local file came from that site.
Connect identifies the exact normalized declaration by its SHA-256 digest.
Changing any declared field creates a different application identity and
requires approval again.

Portable applications can authorize either computer-owned or hosted
collections through the same `MdbaseConnection` API. Add
`"collection_kind": "hosted"` to `requirements` when the application
specifically needs a durable cloud collection; omit it to let the user choose
any compatible local or hosted collection.

## Authorization

The SDK uses OAuth device authorization with PKCE:

1. The file registers its inline manifest and generates a non-extractable P-256
   grant key.
2. Connect returns a random, short-lived device code and an eight-character
   user code.
3. The SDK opens Connect's approval page in a popup and also returns the code
   through `onDeviceCode`.
4. The signed-in user confirms the same code, reviews the unverified downloaded
   file warning, selects a compatible local or hosted collection, and narrows
   the operations.
5. The SDK polls at the server-provided interval. Every successful response is
   bound to the opaque application origin `null`. A local grant must also
   contain the same application public key and encrypted relay protocol 1; a
   hosted grant instead contains a scoped provider capability bound to the same
   public key.

Device codes expire after ten minutes, are stored only as hashes by the control
plane, are rate limited, and can be consumed once. Polling faster than the
returned interval receives `slow_down`. PKCE prevents a copied device code from
being exchanged by another installation.

For a local collection, the connector remains the final authorization boundary.
It accepts the opaque `Origin: null` only when an active local grant has that
exact origin and encrypted relay binding. Every operation must authenticate the
grant, application, connector, collection, key ID, epoch, counter, request ID,
and ciphertext.

For a hosted collection, the SDK sends operations directly to the hosted data
provider. Its short-lived bearer capability selects one replica, collection,
grant, operation set, record scope, and expiry. Every request additionally
carries an ECDSA proof from the approved P-256 key over the method, target, body,
credential, timestamp, and a one-use nonce. The provider requires the exact
`Origin: null`, verifies the signature, and persists the nonce before serving
the operation. Refreshing is signed by the same key and rotates both the Connect
credential and provider capability. A copied bearer or refresh token is
therefore insufficient, and CORS permission alone is never an operation
capability.

## Storage and `file://`

All local files have an opaque browser origin serialized as `null`. A portable
SDK instance therefore uses process-memory token storage and a non-extractable
process-memory private key by default. Portable hosted capabilities keep that
key for request and refresh signing. Another downloaded file cannot inherit the
credentials through
`localStorage` or IndexedDB. Reloading or reopening the file requires
authorization again.

An embedding shell may inject custom `storage` and `keyStore` adapters. That is
an explicit trust decision by the application. A custom key store used with
portable hosted collections must preserve and return the `signingKey` included
in `GrantKeyRecord`; existing local-collection adapters remain compatible.
`connect.environment()` reports whether the defaults are `memory`, `persistent`,
or `custom`.

Code running inside an already approved page has the page's authorized access,
as it would for a website application. A portable app must therefore avoid
untrusted scripts and should pin every CDN resource with Subresource Integrity.

## Version-pinned browser bundle

The npm package includes a dependency-free IIFE bundle:

```text
dist/browser/mdbase-connect.min.js
dist/browser/integrity.json
dist/browser/mdbase-connect.min.js.sha384
```

Use an exact package version, copy the SHA-384 value from that version's
`integrity.json`, and keep `crossorigin="anonymous"`:

```html
<script
  src="https://cdn.jsdelivr.net/npm/@mdbase/connect@0.1.0-beta.4/dist/browser/mdbase-connect.min.js"
  integrity="sha384-6GTn5SRbBhjL6mSvjFUYGC+h7EV/Scj7NzxwbbmCFPWip8vc11F3EiZsOshUvLeP"
  crossorigin="anonymous"></script>
```

The global namespace is `MdbaseConnect`; the manager constructor is
`MdbaseConnect.MdbaseConnect`. Do not use an unversioned CDN URL, a moving tag,
or omit SRI in a downloaded application.

```html
<button id="connect">Connect a collection</button>
<output id="code" aria-live="polite"></output>
<script>
  const manifest = {
    manifest_version: 1,
    distribution: "portable",
    id: "dev.example.portable-notes",
    name: "Portable notes",
    requirements: { access: "full_collection", contracts: [] }
  };
  const connect = new MdbaseConnect.MdbaseConnect({
    serverUrl: "https://connect.mdbase.dev",
    manifest
  });

  document.querySelector("#connect").onclick = async () => {
    const { connection } = await connect.authorize({
      operations: ["describe", "read", "query"],
      onDeviceCode: ({ userCode }) => {
        document.querySelector("#code").textContent =
          `Confirm ${userCode} in mdbase Connect`;
      }
    });
    console.log(await connection.describe());
  };
</script>
```

The application code does not choose a transport. The returned connection uses
the local connector, relay, or hosted provider as required; `describe`,
`query`, `create`, and the other collection methods remain the same. The
read-only `connection.route` property can be used for diagnostics.

Authorization must start from a user gesture so browsers permit the approval
popup. If a caller supplies `openVerification`, it is responsible for showing
or opening the verification URL. If the default popup is blocked, the SDK
throws `approval_window_blocked` with the verification details.
