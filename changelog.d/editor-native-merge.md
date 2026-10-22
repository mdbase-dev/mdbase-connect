## Changed

- The native-SDK Editor from `release/native-staging` is now main's Editor. It publishes only through the native dispatch path on `release/native-<target>`; the legacy main and version-tag Pages jobs and their `verify-editor-publication` guard are removed, so no main push or tag dispatch publishes the Editor.
- Old Editor `/connect` links and the **Open Connect** command open the Connect portal for the build's environment (staging builds use `connect-staging.mdbase.dev`).
