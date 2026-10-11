## Changed

- Pin the editor to the original ad69a506 SDK dev archive with its original connect-protocol dependency archive, installed as ordinary file dependencies in both Docker dependency-install contexts. The archive is a dev intake, not release-qualified.
- Port the editor's SDK mode onto the public `MdbaseApplicationEntry`: `SdkEditorRoot` forwards SDK lifecycle, selection, setup, readiness and connection currentness, and opens the existing editor over a native gateway using the borrowed connection's records, files and people clients. The app-owned native sign-in binding and popup are removed; the Connect gateway remains the production default.
