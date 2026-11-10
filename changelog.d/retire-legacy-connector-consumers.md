## Removed

- The legacy connector client image (`ghcr.io/mdbase-dev/mdbase-connect-client`)
  is no longer built, signed or listed in the release bundle. The shipped
  `mdbase` CLI and daemon come from `runtime/` and are unchanged. CI, the
  `legacy-local` system suite, `pnpm e2e:legacy` and the legacy profiling
  scripts no longer build or run the root legacy connector crates.
