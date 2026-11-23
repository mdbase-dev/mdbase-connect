# Use a hosted web app with your own collection

Most people can sign in to their mdbase app and use its normal collection chooser. This guide is for people who want to **serve their own Markdown folder** and manage which browsers can edit it.

`mdbase pair-app` serves one local collection while the command is running. The browser loads TaskNotes, Editor, or another compatible app from its publisher’s HTTPS site and connects directly to the serving computer.

## Pair an app

1. Open a terminal on the serving computer and run `mdbase pair-app /path/to/collection` (or `mdbase pair-app` in the collection). Use an initialized mdbase collection already containing the resources your app requires. Start with a disposable folder, not your only copy of any data.
2. Get the app’s **direct connection site** from its publisher. Where the publisher has enabled it, the signed-out app links there under its advanced options. Copy the HTTPS origin from the pairing page, confirm its spelling in the terminal, and approve it only if you trust the site to read and edit this folder. For a browser on the serving computer choose loopback. For a phone or another computer, choose the host’s private IPv4 address on their shared Wi-Fi or VPN. The command binds to that address on UDP 14918. Leave router port forwarding off.
3. Choose **pair** and give the browser a recognizable label. On the serving computer, open the link printed in the terminal. On another device, open the link or scan the QR code for the chosen private network address. The link tells the browser which server and certificate to expect. Check the app site and server, then enter the separate eight-digit code from the terminal. If the browser asks for local-network access, allow it for the site you chose.
4. Choose **Remember this browser** if desired. Leave mdbase running while editing. Use **list** or **revoke** in the same terminal to manage access. Ctrl-C stops serving; restart with the same folder, network address and approved sites to reconnect. Guided state lives outside the folder in `~/.mdbase-pairing/`; `--state-dir` or `MDBASE_HOME` selects an existing user-owned base instead. Keep this directory private; it contains the server's TLS private key.

**What happens if the connection drops?** Editing requires a live connection. Copy any unconfirmed text from the recovery screen, reconnect, and check the record on the server before editing again. A save that was already in flight may have succeeded even if its reply never reached the browser. TaskNotes cancels deletes still in their undo window when the session ends. Editor keeps unsaved note text in the tab so you can copy it. Neither app replays those edits on reconnect.

**What works on the network?** The browser must support WebTransport with `serverCertificateHashes` and be able to reach the chosen private IPv4/UDP endpoint. On an existing tailnet, choose its IPv4 address; no Tailscale Serve or Funnel is needed. The VPN's routing and ACLs still apply. Guest Wi-Fi isolation, blocked UDP, HTTPS site permissions or unsupported browsers may prevent a connection. The app does not silently switch to WebSockets, plaintext or an mdbase relay. Use the explicit HTTPS setup below when you already operate a private gateway.

**What if pairing fails?** Check that the browser supports the connection, the server is running, the device is on the selected network, and the browser allows local-network access for this site. The host accepts up to four connections at once, including pairing attempts. Closing another connected tab frees a slot. If the server refused the code, check the digits and the app site. Codes expire after three minutes, five failed attempts, or one successful use. A browser that leaves before sending a code does not use an attempt, and when the app says the server was not reached, the same code is still good. If the connection dropped while submitting a valid code, check **list** on the host before issuing another. The server might already have issued a grant even though the browser missed the reply. Revoke a stranded grant using its label and ID.

**How long does a pairing last?** The code is single-use. When the initial certificate matches the invitation, the host gives the browser its access key and the fingerprints of the certificates it will use over the next year. Routine certificate rotation does not require another code. The browser still verifies the host before sending the key, and revoking a browser takes effect immediately. At the end of the remembered certificate schedule (32 twelve-day slots including the enrollment slot), or if the server address or private state changes, revoke the old grant and issue a fresh invitation and code. Clearing the browser's site data also requires pairing again. These fingerprints are not backup credentials: never disable pin verification or try the saved access key at another endpoint.

## Advanced: private HTTPS gateway

1. Start with a backed-up, initialized mdbase collection on a machine you control. For TaskNotes it must already have the required TaskNotes resource packs. The server will not import a vault, install packs or take a collection lock away from another process. Test with a synthetic folder first.
2. Pick a dedicated **private backend HTTPS hostname**. Set up DNS and a certificate trusted by the client devices. Restrict access to the operator's chosen LAN/VPN peers with a firewall. The browser, not the static UI server, must be able to reach this hostname. Do not port-forward the backend to the internet.
3. Obtain the exact HTTPS origins of the **self-hosted connection editions** of your apps from their publisher. Origins below are illustrative, not live services. Enter origins without a path or trailing slash. Start the service as an unprivileged user with private state outside the collection and web root:

```sh
umask 077
collection=/absolute/path/to/collection
auth="$HOME/.local/state/mdbase/self-host/personal"
install -d -m 700 "$(dirname "$auth")" "$auth"
tasks=https://tasks-ui.example
editor=https://editor-ui.example
operator() { mdbase self-host --collection "$collection" --auth-dir "$auth" "$@"; }
operator --origin "$tasks" --origin "$editor" serve --listen 127.0.0.1:14918
```

4. Terminate TLS on the same machine. Forward WebSocket upgrades **only** for `/_mdbase/pair` and `/_mdbase/replica` to `127.0.0.1:14918`, preserving the actual `Origin` and request target. Reject other paths. Do not synthesize an allowed Origin, expose files or directory listings, record WebSocket payloads, or forward the port on a public interface. The proxy is trusted with plaintext; a VPN does not replace TLS or app authorization.

   For Caddy there is a [minimal working configuration](examples/self-host.Caddyfile). Set `MDBASE_BACKEND_AUTHORITY` to the backend `hostname:port` and `MDBASE_TLS_CERT` and `MDBASE_TLS_KEY` to the absolute paths of your certificate chain and private key. It binds **only to loopback** by default and uses your existing certificate, with no public ACME challenge or HTTP redirect listener. To serve your other devices, replace the single `bind 127.0.0.1` with the host's specific private VPN interface address and restrict peers at the firewall. Keep the upstream daemon on loopback. Run `caddy validate --adapter caddyfile --config self-host.Caddyfile` before starting Caddy with the same adapter and file.
5. In a second terminal on the host, define the same shell variables/function and open a pairing window for **one app**:

```sh
operator --origin "$tasks" pair 'Laptop Tasks'
```

Give the user the backend HTTPS origin and the eight-digit code through a trusted channel. Do not send the code in a link, shell argument, issue, or screenshot. In the app's self-hosted connection screen enter both and select **Pair browser**. The code expires after three minutes and five attempted redemptions; successful redemption consumes it. To open Editor, issue a **fresh** code with `--origin "$editor"`. A credential issued for one app cannot be used from the other app origin.

### Reconnect, revoke, recover

- Optional **Remember this browser** stores an origin- and backend-bound credential as AES-GCM ciphertext with a non-extractable key in browser IndexedDB. The OTP is not stored. Clearing the HTTP cache does not erase a pairing; clearing site data does. Without Remember, reloading requires a fresh code.
- A backend outage is not revocation. Restore connectivity and retry; don't issue another code unless the saved grant is lost or rejected. A browser local-network permission, DNS or certificate failure can also look like an outage. Do not disable certificate checks or browser security to recover.
- `operator --origin "$tasks" list` prints browser IDs and your labels, not secrets. `operator --origin "$tasks" revoke BROWSER_ID` denies that browser, including its active connection. **Forget** in an app only removes its local pairing; use the CLI to revoke a lost device. Revocation cannot erase downloaded data.
- Only one pairing window is open per UI origin. A new `pair` replaces its pending code, not its existing browsers. If the connection drops during redemption, check `list`: if that label was issued but no browser received the credential, revoke its ID before pairing again with that label. Do not keep retrying a possibly consumed code.
- On restart supply the original collection, auth directory and complete allowed-origin list. Omitting a formerly allowed origin revokes its grants; adding it back is not restoration. Never restore a stale copy of authorization state to undo revocations; after a compromise stop serving, start with fresh private authorization state and pair again. Treat copies of both the collection and auth database as sensitive. Authorization state in an unsupported format is rejected; move it aside and pair again.

## Trust and support boundaries

- Pairing authorizes **read and edit access to this collection**. A browser cannot administer the host, change its trust list or issue pairing codes. Treat the host account, UI publisher, same-origin scripts and (only in gateway mode) TLS proxy as trusted. Storage wrapping does not prevent script running as the app from using an unlocked grant or reading open records. An `Origin` header is not proof of identity outside a browser: the credential is also required.
- Host each direct UI on a dedicated worker-free HTTPS origin, with its supplied static security headers. Do not overlay it on a managed PWA root, relax the managed CSP, inject analytics scripts, or silently unregister workers. A new UI hostname needs a new operator authorization. Pin the UI destination in the build, never take it from a query parameter or note link.
- One local host, one collection per process, up to four simultaneous socket connections (including pairing). Hosted notifications, an offline-ready replicated collection, managed timers, administration and schema changes are not part of this transport. Attachment uploads are limited to 4 MiB, one in flight per session, and not resumable. Pre-existing binaries are not automatically indexed. No Windows/native mobile support is claimed.
- The local SDK subpath `@mdbase-dev/sdk/direct` exposes `directBackendOrigin`, `pairDirect`, `connectDirect` and `createDirectGrantStore`. The first application message carries the OTP (pair) or browser credential (replica), never a URL parameter or HTTP credential. The replica then uses its existing framed `hello` and returns an ordinary `MdbaseClient`. Do not retry an ambiguous OTP redemption automatically. Close the old client when switching grants; discard a saved credential only on explicit user action or server denial, not on an unexplained network failure.

## Adding another web app

On a dedicated HTTPS entry, use the `/direct` subpath instead of starting the managed SDK. The host invitation has the form `https://app.example/#mdbase-pair=<percent-encoded descriptor>`. Take the fragment out of browser history before routing, treat its value as untrusted form input, and never send it to the static server. The descriptor for WebTransport is `https://PRIVATE_IPV4:PORT#sha256=LOWERCASE_HEX_DIGEST`; a bare HTTPS origin explicitly selects WSS. Do not strip or replace the fingerprint. After the user confirms the backend and submits the code:

```ts
import { connectDirect, directBackendOrigin, pairDirect } from "@mdbase-dev/sdk/direct";

const server = directBackendOrigin(enteredOrigin);
const token = await pairDirect({ server, code: enteredCode, signal });
const client = await connectDirect({ server, token, app: { name: "my-app", version: "1" }, signal });
```

Give `client` to the same repository layer used for managed collections. Await write confirmation before reporting success. On a disconnect, stop accepting writes, let the user copy unconfirmed text, and re-read the record after reconnecting. Keep delayed deletes and automatic mutation replay out of the direct entry. A network failure after submission can leave the outcome unknown.

Clear the code on submission. Keep a tab-only credential in memory so the user can retry a dropped connection without redeeming another code. For an explicit **Remember** choice use `createDirectGrantStore("my-app").save({ server, token })`. Reconnect only to that grant’s saved server. A different invitation requires a new choice, even when its hostname matches and its fingerprint differs. Use the receipt returned with a saved grant to `forget(receipt)` after an authorization refusal, so a stale tab cannot erase a newer pairing.

## Can the publisher count usage?

No usage beacon is part of serving, pairing, connecting, reading or writing. The managed account metrics are **not** a count of self-hosted users. The operator's `list` is a list of authorized browser grants, not unique people or evidence of recent use.

For a rough measure of interest, a publisher can use aggregate counts of GETs for each direct UI's entry document on infrastructure it already controls. Count only date, app and request total; avoid retaining raw URLs, Referer, IP addresses or device identifiers for this purpose. Reloads, caches and bots make this a **page-load** measure, not successful connections or active users. Fully self-hosted/offline UIs need not appear at all. If successful-use measurement is needed later, obtain explicit consent in the app, disclose the destination and retention, and design a bounded aggregate signal. Do not retrofit a silent SDK/daemon ping or claim that a session count is a people count.

## Build and verify without a deployment

Use Node 24, the repositories' pinned pnpm, Playwright Chromium, OpenSSL, and a Unix host. From the Connect worktree:

```sh
(cd runtime && rcargo --pull mdbase build --locked -p mdbn-daemon --bin mdbase)
binary="$PWD/runtime/target/debug/mdbase"
(cd runtime && rcargo test --locked -p mdbn-daemon --test web_replica)
python3 runtime/scripts/qualify-pair-app.py "$binary"
pnpm install --frozen-lockfile
pnpm build:packages
MDBASE_EDITOR_DIRECT_ORIGIN=https://127.0.0.1:15917 pnpm --filter mdbase-editor build:direct
node apps/editor/scripts/direct-proof.mjs "$binary"
```

Without the remote builder, use `cargo build` and `cargo test` with the same Cargo arguments in `runtime/`. In the separate TaskNotes checkout, run `pnpm install --frozen-lockfile`, `pnpm build:self-hosted`, then `node scripts/direct-web-proof.mjs /absolute/path/to/mdbase out/self-hosted`. Both proofs run their own daemon, private collection, TLS endpoints and browser; never substitute an installed daemon or real collection. The CLI tests also exercise two allowed app origins **at the same time**, including isolation of codes, browser credentials and revocation.

For the private **WebTransport** path, the separate Linux harness uses a disposable network namespace, browser profile and collection. It serves only the static HTTPS test origin through Playwright's request handler. The browser itself performs the QUIC handshake, certificate verification, local-network permission check and replica requests. No shared trust store or managed service is needed. With the dependencies listed in `runtime/scripts/qualify-webtransport.sh` and the two direct builds installed, run from the Connect worktree (the UI origin must match the app build's configured HTTPS origin):

```sh
editor_ui=https://127.0.0.1:15917
tasks_ui=https://tasks-qualification.invalid
tasknotes_tree=/absolute/path/to/tasknotes-app-worktree
runtime/scripts/qualify-webtransport.sh platform
runtime/scripts/qualify-webtransport.sh editor "$binary" apps/editor/dist-direct "$editor_ui"
runtime/scripts/qualify-webtransport.sh tasknotes "$binary" "$tasknotes_tree" "$tasknotes_tree/out/self-hosted" "$tasks_ui"
runtime/scripts/qualify-webtransport.sh --net-fixture editor "$binary" apps/editor/dist-direct "$editor_ui"
runtime/scripts/qualify-firefox-pairing.sh "$binary" apps/editor/dist-direct "$editor_ui"
```

The Firefox fixture repeats one-time enrollment in Editor and checks that every issued grant opens the collection. To exercise certificate rotation in either Chromium app, use `--rollover` and the process-local clock library described in `runtime/scripts/qualify-webtransport.sh`.

The default fixture has only loopback. `--net-fixture` links two separate disposable network namespaces with RFC1918 addresses; it does not touch a real interface. Neither proves a public hosting configuration, a phone camera, a physical Wi-Fi router, or Tailscale ACLs. Before enabling a public chooser link, repeat invitation → permission → pair → edit → reload → revoke on the intended browsers, over real private networks, without an installed test CA, TLS exception or browser switch. Record browser versions and permission denials as well as success. A build with the UI links disabled is not a deployment or a claim of mobile support.

The direct builds use a vendored SDK made from `runtime/packages/sdk`, separate from the released SDK originals used by the managed apps. Each app keeps `vendor/sdk-self-hosted-<sha256>.tgz` beside a `.json` of the same name recording the archive's digests, the commit and Git tree of `runtime/packages/sdk` it was built from, and the Node and npm versions used. `node runtime/packages/sdk/scripts/direct-archive.mjs verify <that .json>` extracts the recorded tree, runs `npm ci --ignore-scripts`, `tsc -p tsconfig.build.json` and `npm pack --ignore-scripts`, and fails unless the result is byte-identical; use the recorded Node and npm versions. `build <commit> <directory>` makes a new archive from a committed tree only. Changing the archive must change its filename, alias specifier and frozen integrity: a warm pnpm installation can otherwise reuse previous bytes for the same file URL. This is **not** a replacement for normal SDK publication, runtime pin or managed app provenance checks.

### Before enabling a hosted entry

- Qualify the CLI and SDK together from reviewed source on the release base. Build the canonical app-runtime WASM and run `node scripts/sdk-publication.mjs check-runtime-pin`; if the runtime changed, follow the normal clean-commit `pin-runtime` process. Use the normal authenticated SDK artifacts and publisher gates for releases; do not relabel a local archive as a published SDK.
- Test the intended browser and device from the actual HTTPS UI to a representative private backend, including certificate trust, private-network permissions, denial, reconnect and revoke. Two HTTPS loopback origins exercise the app protocol but not a real public-site-to-VPN permission policy.
- Keep each managed chooser link unconfigured until its dedicated UI is available and verified. To withdraw the feature, remove the link and direct site; operators can remove its exact origin from `serve` to revoke existing browser grants. Removing a link alone does **not** revoke them.
