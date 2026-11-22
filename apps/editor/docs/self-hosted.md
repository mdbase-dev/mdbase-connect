# Edit notes on your own server

Open the invitation link printed by the host in the browser you want to pair. The self-hosted editor removes the invitation from the address bar and shows the requesting host. Match that host to the computer displaying your **eight-digit pairing code**. Enter the code and select **Pair and open collection**. The host must stay online while you edit.

On the signed-out screen of a publisher-enabled Editor, follow **Advanced · Connect to your own server**. You can paste a full invitation for that exact Editor site or the complete server address with its certificate fingerprint. A trusted HTTPS reverse proxy also accepts a bare HTTPS server address. Check the displayed server against the computer that supplied the code. **Return to mdbase editor** opens the regular account-based Editor.

**Remember this browser** is off by default. Without it, a reload needs a fresh pairing code. With it, the same invitation (including its fingerprint) reopens the saved connection. A different invitation asks you to choose. A remembered private-network pairing supports scheduled certificate rotations at the same address. When the schedule expires or the address changes, ask for a fresh invitation and code.

Choose a note, edit its Markdown source and select **Save note**. If the connection drops, copy any unconfirmed text from the read-only field. **Reconnect** reuses the grant held by this tab. After copying the text, select **Discard and open notes** to reopen notes from the server. Recovery text stays in this tab until you discard it or leave. The Editor never submits it on reconnect. If a save was in flight, reopen the note to check what reached the server before making another edit.

**Forget this browser** erases the browser’s saved connection. To revoke the grant on the server, contact the person who issued the pairing code. See [the server guide](../../../runtime/docs/self-hosted.md) for pairing, TLS and revocation.

## Build boundaries

From a frozen workspace install with workspace packages built, set `MDBASE_EDITOR_DIRECT_ORIGIN` to the same **bare HTTPS origin** for both builds, for example:

```sh
export MDBASE_EDITOR_DIRECT_ORIGIN=https://direct-editor.example.org
pnpm --filter mdbase-editor build
pnpm --filter mdbase-editor build:direct
```

The ordinary build outputs `dist/`. Without the variable, the existing managed app has no self-hosted destination. The direct build requires the variable and outputs **only** to `dist-direct/`. Serve that directory at the root of a separate, worker-free HTTPS origin. Never combine the artifacts, publish the direct files under the managed scope, inject scripts/analytics or rewrite unknown paths to an application entry. Preserve the supplied CSP, no-referrer and frame restrictions (apply `dist-direct/_headers` yourself when your host does not interpret it). Configure the *UI origin* on the server; the host puts only the percent-encoded backend descriptor in the UI’s `/#mdbase-pair=…` fragment. Keep the code, grant and collection details out of links. The browser sends the code directly to the confirmed backend over pinned WebTransport, or WSS for the trusted-proxy setup. A browser on the wrong origin, in a frame, with a non-root URL or with any service-worker registration is refused rather than automatically unregistering the worker.

To verify against synthetic records, follow the [disposable Chromium proof](../../../runtime/docs/self-hosted.md#build-and-verify-without-a-deployment). Its fixture build uses `https://127.0.0.1:15917` rather than the publisher address. Neither that proof nor the direct build needs the installed daemon or a deployment.

## Managed publication

The production Editor publisher also publishes the direct build to `https://editor-self-hosted.mdbase.dev` (Pages project `mdbase-editor-self-hosted`) after the managed Editor is published and smoked, from the same commit and artifact. A source opts in with `apps/editor/direct/publication.json`, whose origin must equal the publisher's fixed origin. The managed build is never given `MDBASE_EDITOR_DIRECT_ORIGIN`, so its link to the self-hosted Editor stays off until that variable is set deliberately. The served entry asset ends in `-<first 12 characters of the source commit>.js` and every page carries `<meta name="mdbase-build" content="…">`. The job retains `editor-self-hosted-receipt-RUN-ATTEMPT` and, when its upload or verification fails, restores the previous deployment and fails the run.

