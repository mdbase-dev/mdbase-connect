# Native application platform (2026-10-26)

SDK, control-plane registration/consent, and log transport must ship together.
The manifest adds optional `platform: "native"` to the existing browser-paired
declaration (`distribution: "web"`, including its omitted default). Omission
preserves web behavior. Portable device-code declarations remain separate. The
field is included in the existing canonical declaration digest; it is a claim
about runtime, never verified publisher identity.

For a declared native application, production accepts canonical origins
`http://127.0.0.1:<port>` on any valid port, following RFC 8252 §7.3. This narrow
exception applies to SDK origin checks, manifest homepage/redirect validation,
and app-runtime installation admission. `localhost`, subdomains, other IPs,
IPv6, credentials, and opaque/custom origins receive no native exception.
Existing LAB/local development behavior stays separate. An origin and port are
still bound exactly to the installation, storage, pairing and resulting grant;
the platform declaration does not make credentials portable between origins.
Redirects stay exact manifest entries (including path/query/port); any port may
be declared, with no redirect wildcard or authorization-code matching change.

The requested log CORS pattern is `http://127.0.0.1:*`, not a general hostname
or IP wildcard. mdbase-next main has already superseded the exact-string
`LOGSVC_CORS_ORIGINS` allowlist: its log Worker returns
`Access-Control-Allow-Origin: *` without credentials for every origin. Preserve
that policy; it already covers every loopback port. Add regression cases for
multiple ports rather than restoring an origin allowlist or a config knob.
Connect’s imported log runtime still uses the allowlist: add only the literal
`http://127.0.0.1:*` configuration pattern there, reflecting the matched exact
request origin. No hostname wildcard, HTTPS/IPv6 loopback pattern or general
glob is accepted. Without this explicit entry, exact-origin behavior is preserved.
Allowed methods/headers, bearer authentication, nonce signatures and replay
checks continue to apply. No deployment/configuration change is part of this work.

Native consent says **"an app running on this computer"** and explicitly says
its identity is unverified. Do not display a manifest-supplied icon or present
the application name/homepage as verified branding. The user must have started
the connection and approve the existing pairing flow and collection permissions.

A remote web page cannot assign itself a loopback origin: requesting or framing
a loopback URL does not give the remote page that origin or its storage. A local
process can already call the log directly without browser CORS enforcement.
Security rests on deliberate consent plus pairing and the existing authenticated
installation/grant/proof checks, not on a loopback port proving publisher identity.
A malicious local process, compromised loopback server or same-origin code can
impersonate a local app; native consent must not imply protection from that.

`app://obsidian.md` is explicitly refused. Every Obsidian plugin and vault shares
it, so it provides neither plugin identity nor vault isolation. Per-vault storage
and plugin mirroring are separate backlog work.
