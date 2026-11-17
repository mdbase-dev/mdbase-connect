## Changed

- The control plane now creates new accounts on the `next` backend when `MDBASE_NEW_ACCOUNT_BACKEND` is unset or empty; the old default was `legacy`. The server refuses to start with `next` selected unless `MDBASE_NEXT_CONTROL_PLANE=1` is configured. Deployments that relied on the old default must now set `MDBASE_NEW_ACCOUNT_BACKEND=legacy`.
