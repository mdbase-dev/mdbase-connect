# Native Editor publication

The native path is the only publication path of the `Editor CI and release`
workflow. Main pushes, pull requests and dispatches with a blank `source_sha` run
the Editor checks and publish nothing.

For an authorized native publication, dispatch the workflow on the literal
`release/native-staging` (or separately authorized `release/native-production`)
branch with `target` and its exact full HEAD `source_sha`. Source qualification
and a deployment GO must precede dispatch. A PR/CI result is not Stage acceptance.

## Existing trust handoff, not CI authentication

The ten original public target packet files live under
`vendor/native-release/<target>/`. `config/native-publish/<target>.json` binds the
accepted SDK source/tree and original facts digest as DATA, never authorization.
Off-CI release/asset authentication is not repeated or replaced in CI. The SDK,
UI and direct protocol remain original file archives. No LAB archive retargeting,
repacking, generated trust context or replacement receipt is allowed.

Protected `editor-staging` environment variables:

| Variable | Original SHA256 |
| --- | --- |
| `NATIVE_SDK_SHA256` | `15eb64b50fc7c2809ff3dba9cce5104fe48d8592208b3af8acb529862a1af18c` |
| `NATIVE_UI_SHA256` | `8f785294454321c40596bdaad976dc4c5374c3f23dfa828f47e3e7b3139b77e5` |
| `NATIVE_PROTOCOL_SHA256` | `cd1e15236ab7e25c511a4ba13af6a9df23f4b41715161479bba97b0445e1c138` |
| `NATIVE_TRUST_ASSET_SHA256` | `67e117646c9c26927f0d5a44cbd26f057c318975032e9cd24f24b020150cdbc7` |

The fourth value is the RAW signed asset, not its module, context or receipt.
Facts digest: `d54aef71521ab3561bd9a81cd1303410a3fde29f8fbd35a1e0041e58d0569de3`.
The ordinary Editor dependency uses the unchanged original production SDK with
beta.141 trust. Its production packet is supplied separately from staging and
uses the same existing intake checks; no trust is minted or authenticated here.
The staging packet and its publisher tests are historical inputs, not a
publishable main candidate: main no longer matches the staging archive hash.

Protected `editor-production` environment expectations (owner-configured, not
inspected or changed by this source):

| Variable | Original SHA256 |
| --- | --- |
| `NATIVE_SDK_SHA256` | `e64771a90bed2fb3837d4b65df8930fcd124d3059fcb0bcbaf9d64dbfb148205` |
| `NATIVE_UI_SHA256` | `8f785294454321c40596bdaad976dc4c5374c3f23dfa828f47e3e7b3139b77e5` |
| `NATIVE_PROTOCOL_SHA256` | `cd1e15236ab7e25c511a4ba13af6a9df23f4b41715161479bba97b0445e1c138` |
| `NATIVE_TRUST_ASSET_SHA256` | `7912e40838213e60b65848350d319a48019021317b112e3326429b250f0133d7` |

Production packet facts digest:
`51bdf004a7f5a72a358b4534660b11f23196cb23a8d583138b75bbc284719617`.
This intake is not per-app live qualification or a deployment GO.

## Build and upload

1. A dependency-free guard checks exact clean source/ref, frozen archive pins,
   complete original inventories and unchanged packet bindings. Four nonsecret
   expectations leave the protected input job; the build has no environment or
   Cloudflare credentials.
2. Frozen install disables lifecycle/pnpmfile hooks. ALL installed original
   SDK/UI/protocol members are compared before any build/package execution.
   Hoisted installer dependencies and CLI links are not claimed as original
   members; a namespace is ignored only if the archive owns no member in it.
   SDK bundled dependencies remain fully compared. No byte-exact shim classifier,
   unlinking or new authentication is involved.
3. The unprivileged build produces the final static inventory AFTER the existing
   SDK offline-shell build. Immutable artifact ID/digest, repository, exact run
   attempt, workflow/ref, source/tree, plan and complete inventory are rebound
   before and after download in the protected upload job.
4. That job never installs/builds application code. It installs only the separate
   official Wrangler4.114.0 npm lock with scripts disabled, outside the checkout.
   Source-owned static controls reject Pages Functions/Workers. Existing Pages
   project `mdbase-editor` is checked, never created. Current native HEAD and
   inventory are checked immediately before the sole upload.
5. Resolve the actual full UUID using page20 plus exact uploaded URL, full source
   and Pages channel; the short URL prefix is not a UUID. Verify ALL served bytes,
   source-owned headers and routes on BOTH deployment URL and custom alias. The
   immutable deployment URL is verified once, within 3 minutes; any failure there
   is terminal, and security failures are never retried inside a verification.
   Only after it passes is the alias re-verified in full, read-only, every 15
   seconds within a 5-minute settle window, because the alias can briefly keep
   serving the previous deployment. A failed attempt is never accepted; the
   receipt records every alias attempt and the final report per origin. Retain an
   honest incomplete/failure receipt; never rebuild, redispatch or roll back as
   an automatic verification response.

External owners must configure exact protected native refs and environment
branch policies, no admin bypass, target-scoped credentials, and Callum's separate
production reviewer/GO. This source does not configure or attest those controls.
Receipts establish static publication custody only, not Native/Worker account,
device, sign-out, memory, file-operation or production admission.

Local source checks use `rpnpm --node 24.19.0 test:publisher` from this directory.
Wrangler syntax reference: https://developers.cloudflare.com/workers/wrangler/commands/pages/#pages-deploy
