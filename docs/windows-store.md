# Microsoft Store distribution

The Windows Store product is **mdbase connect**, an MSIX/AppX desktop application.
Microsoft hosts and signs the package and owns installed package updates. GitHub's
Squirrel and portable downloads stay unsigned; Store enrollment does not give those
files an Authenticode certificate.

## Product identity

Reserved in Partner Center on 2026-09-22:

| Actions variable | Value |
| --- | --- |
| `WINDOWS_STORE_PRODUCT_ID` | `9MT616XM0NND` |
| `WINDOWS_STORE_IDENTITY_NAME` | `CallumAlpass.mdbaseconnect` |
| `WINDOWS_STORE_PUBLISHER` | `CN=D1A77B78-D6FD-46F1-B8C2-E35085AB54BE` |
| `WINDOWS_STORE_PUBLISHER_DISPLAY_NAME` | `Callum Alpass` |

These are public package identifiers, not credentials. The package family is
`CallumAlpass.mdbaseconnect_kazq2b469see8`.

`configure-windows-store-package.ps1` fills `apps/desktop/assets/AppxManifest.xml`,
creates the build-time development certificate and points Forge at the generated
manifest. `verify-windows-packages.ps1` checks the packaged manifest and signature.

## What the package declares

- `runFullTrust`: Electron and the bundled Rust daemon run as ordinary desktop
  processes. Do not describe the app as sandboxed in an AppContainer.
- `unvirtualizedResources`, with `FileSystemWriteVirtualization` disabled: the app
  copies its daemon to `%LOCALAPPDATA%\mdbase\state\runtime` and registers a
  scheduled task to run it at logon. With virtualization on, that copy lands in the
  package's private `LocalCache`, the task cannot find it, and the app fails with
  `mdbase service install failed`. This is a restricted capability, so explain it
  in the certification notes.
- The `mdbase-connect://` protocol. The package owns it, so the app does not
  register it through Electron.

Store builds offer no launch-at-login setting: the registry-based toggle would point
at a versioned WindowsApps path, and the package has no `StartupTask` yet. The
daemon's own scheduled task still starts at logon.

## First publication

The first submission is manual in
[Partner Center](https://partner.microsoft.com/en-US/dashboard/products/9MT616XM0NND/overview).

1. Set the four identity variables and leave `WINDOWS_STORE_LIVE` unset. Do not
   set them on workflow revisions without the `WINDOWS_STORE_LIVE` guard, or signed
   update feeds would link to a Store page that does not exist yet.
2. Complete a coordinated release as described in [releasing.md](releasing.md).
   Download that run's `windows-store-submission` artifact and upload its `.appx`.
   A pull request build is not an eligible artifact.
3. Test the real package on Windows: clean install, sign-in, browser deep links,
   adding a folder, and replacing one package version with the next, with the app
   open and closed and the daemon running and stopped.
4. Submit for certification, then verify the public Store page and a real install.
5. Only then set `WINDOWS_STORE_LIVE=true`. It offers the Store link in **future**
   signed channel manifests; published manifests stay immutable.

Submitting later versions through the Store API is not set up. It clones a previously
published submission, so it can only start after the first publication.
