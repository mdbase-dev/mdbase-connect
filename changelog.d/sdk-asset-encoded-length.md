## Fixed

- Load the SDK's runtime and SQLite WebAssembly from hosts that serve them compressed with the compressed size as `Content-Length`, such as GitHub Pages. Signing in to an app hosted there no longer fails while preparing this browser's device.
