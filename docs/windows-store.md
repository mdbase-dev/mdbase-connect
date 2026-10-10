# Microsoft Store distribution

The Windows Store product is **mdbase connect**, an MSIX/AppX desktop application,
not an EXE/MSI listing. Microsoft hosts and signs the package and owns installed
package updates. GitHub's Squirrel/portable downloads remain explicitly unsigned;
Store enrollment does not give those files an Authenticode certificate.

## Product identity

Reserved in Partner Center on 2026-09-22:

| Repository Actions variable | Value |
| --- | --- |
| `WINDOWS_STORE_PRODUCT_ID` | `9MT616XM0NND` |
| `WINDOWS_STORE_IDENTITY_NAME` | `CallumAlpass.mdbaseconnect` |
| `WINDOWS_STORE_PUBLISHER` | `CN=D1A77B78-D6FD-46F1-B8C2-E35085AB54BE` |
| `WINDOWS_STORE_PUBLISHER_DISPLAY_NAME` | `Callum Alpass` |

These are public package identifiers, not credentials. Use **repository-scoped**
variables: the platform build jobs do not select a GitHub environment.
The package family is `CallumAlpass.mdbaseconnect_kazq2b469see8`.

`configure-windows-store-package.ps1` fills the repository-owned AppX manifest
using an XML DOM, creates the build-time development certificate, and supplies
Forge with the generated manifest. The manifest declares the desktop target,
bundled executable, full-trust capability and `mdbase-connect://` protocol.
The native Windows job verifies the packaged manifest and signature.
The self-signed development certificate is not distributed as a trust root;
Microsoft replaces the signature during Store ingestion.

## First publication is manual

The initial Partner Center submission must include pricing/markets, Properties,
age ratings, packages, an English listing with real Windows screenshots, and
certification notes. CI cannot invent the questionnaire answers, screenshots,
or a reviewer's authenticated account. The API clones a **previously published**
submission; do not try to replace an incomplete first draft using CI.

1. Complete the listing in [Partner Center](https://partner.microsoft.com/en-US/dashboard/products/9MT616XM0NND/overview).
   Use `https://mdbase.dev/privacy/` for privacy, `https://mdbase.dev/` for the
   website and the public repository issues page for support. The desktop itself
   is free; describe any account/hosted-service requirements accurately.
2. Configure the four identity variables above. Keep `WINDOWS_STORE_LIVE` and
   `WINDOWS_STORE_SUBMISSION_ENABLED` unset during bootstrap. Do not configure
   identity on older workflow revisions which lack the live-listing guard.
3. Complete the ordinary coordinated release qualification and post-production
   desktop dispatch described in [releasing.md](releasing.md). Download the
   **same run's** `windows-store-submission` artifact, verify its Sigstore bundle,
   and upload its `.appx` to the first Partner Center submission. A PR build or
   changed source checkout is not an eligible public release artifact.
4. Test the actual packaged app on Windows, including clean installation,
   browser deep links, named-pipe/loopback access, folder access and daemon
   lifecycle. Test Store replacement from one real package version to the next,
   with the app open/closed and the daemon running/stopped. Retain evidence.
5. Submit for certification. The `runFullTrust` explanation should describe
   Electron and the bundled Rust daemon, explicitly chosen local folders,
   user-approved application grants and outbound encrypted connections.
   Do not claim the app runs in an AppContainer sandbox.
6. After certification, verify the real public Store page and installation.
   Only then set repository variable `WINDOWS_STORE_LIVE=true` to offer the
   Store link in **future** signed channel manifests. Published manifests and
   release tags remain immutable.

### Windows lifecycle acceptance is still required

Store replacement is not the macOS Electron updater transaction. Before ordinary
IPC admission, the existing `UpdateCoordinator.initialize()` invokes
`ElectronUpdateBackend.reconcileInstalledRuntime()`: a missing, stopped or older
service is reconciled from the new bundled executable. The CLI installs a private
stable runtime outside the package directory and registers the Windows background
task against that runtime. Exact version, readiness and local-protocol checks
remain mandatory; failure blocks startup instead of claiming an update succeeded.
`store-update-startup.test.mjs` exercises this existing boot path with a simulated
OS boundary, including install failure. No second updater is introduced.

Actual Store identity/WindowsApps filesystem virtualization, task registration,
package replacement and service health still need native Windows N→N+1 acceptance.
Do not enable unattended Store publication until that evidence is retained.

Store builds do not offer the existing registry-based launch-at-login toggle:
it is not a packaged StartupTask and would refer to a versioned WindowsApps
path. Store-specific startup-task support is separate work. Protocol registration
is package-owned rather than performed through Electron's registry API.

## CI identity: no long-lived client secret

Associate an operator-controlled Microsoft Entra tenant with the Partner Center
account. Do not attach an employer's tenant or create a paid subscription for
this purpose without authorization. Create a dedicated Entra application and
add it to Partner Center with the application-management permissions required by
the submission API (Microsoft documents the Manager role).

Create its federated credential:

- issuer: `https://token.actions.githubusercontent.com`
- subject: `repo:mdbase-dev/mdbase-connect:environment:windows-store`
- audience: `api://AzureADTokenExchange`

Create a protected **windows-store** GitHub environment, restricted to reviewed
release tags, with required reviewers where available. Set its non-secret
`WINDOWS_STORE_TENANT_ID` and `WINDOWS_STORE_CLIENT_ID` variables. No password,
client secret, browser cookie or SAS URL belongs in repository files or logs.

After the first release is live, native upgrade acceptance has passed, and the
federation/application permission setup is verified, set the repository variable
`WINDOWS_STORE_SUBMISSION_ENABLED=true`. The job-level switch must be repository
scoped; environment variables are not available while selecting a job.

## Subsequent releases

The existing tagged **Desktop Release** workflow:

1. builds and verifies the AppX at `1.0.<GitHub run number>.0`;
2. signs its provenance and retains it in `windows-store-submission`;
3. publishes the guarded GitHub release;
4. enters the protected `windows-store` environment under one global,
   non-cancelling concurrency group;
5. verifies the exact same-run AppX's tag-bound provenance;
6. obtains a short-lived Store token using GitHub OIDC federation;
7. refuses mismatched identities, existing drafts, first publications, unsupported
   package architectures and non-increasing package versions;
8. clones the last published submission, changes only the x64 package set,
   uploads the package ZIP and commits the attributable new submission.

The current production-publication verifier repeats before creation and before
commit. Listings, pricing, markets, certification notes and rollout policy are
inherited, not regenerated. The baseline must use immediate publication after
certification; manual/scheduled publication is not silently changed by CI.
The job records bounded submission IDs/phases, not API response bodies.

A successful upload/commit **does not mean certification succeeded or the app is
live**. Check Partner Center's certification result and public install/version.
Windows Store manages replacement according to its settings and inherited rollout
policy. The GitHub manifest's rollout percentage does not control Store delivery.
New GitHub releases can precede Store certification; opening the Store does not
prove that the same version is available there yet.

## Failure and retry

Never edit a CI-created submission in the browser while CI owns it. Do not run
manual and automated submission writers concurrently. Existing submissions block
CI; there is deliberately no delete-draft or overwrite switch.

Transport errors after writes have an **unknown** outcome. Preserve
`windows-store-submission-evidence`, inspect the exact submission in Partner
Center and reconcile it before retrying. Writes are not retried automatically.
A failed Store job does not retract a successfully published GitHub release.
After reconciliation, rerun only the failed Store job while the same candidate
remains independently production-verified. Do not rebuild or replace immutable
release assets. A completed submission cannot be blindly replayed: an existing
pending submission or non-increasing package version stops it.

## References

- [Store submission API prerequisites](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services)
- [Packaged app submission lifecycle](https://learn.microsoft.com/en-us/windows/uwp/monetize/manage-app-submissions)
- [GitHub OIDC with Entra](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust-github)

This integration deliberately uses the documented packaged-app API directly:
the supported MSStore CLI currently deletes an existing pending submission when
publishing an update and can log its upload SAS URL. Neither behavior is suitable
for unattended, fail-closed package-only updates here.
