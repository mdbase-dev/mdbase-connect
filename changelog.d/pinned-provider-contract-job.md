## Added

- Server CI runs the hosted-provider system suite against the provider image production runs, pinned in `deploy/docker/hosted-provider-image`, in the merge queue and on pull requests that change the control plane or protocol. Run it locally with `pnpm e2e:provider:pinned`.
