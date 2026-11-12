## Security

- The macOS desktop release job now provisions the Apple signing keychain and
  App Store Connect key after dependency installation and the build, and passes
  the API key only to the packaging step that signs and notarizes.
- The runtime CI workflows reference third-party GitHub Actions by full commit
  SHA instead of by tag.
- The server, MCP, hosted-provider and NATS container images build from base
  images pinned by digest.
