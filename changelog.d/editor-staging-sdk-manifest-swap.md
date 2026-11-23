## Fixed

- Rewrite every workspace manifest that references the Editor's vendored production SDK tarball (including `packages/app-ui` and `services/mcp`) during the staging native Editor SDK swap, verifying each manifest's exact production pin before modifying files so `pnpm install --frozen-lockfile` stays consistent. Also restore all rewritten workspace manifests in `dry-build.mjs`.
