## Changed

- Include a normalized CPU model slug in the `runner` label of nightly `runtime-v1` performance reports (for example `linux-x64.amd-epyc-9v74` and `linux-x64.intel-xeon-6975p-c`) so ops compares like-for-like runner hardware instead of reporting false regressions when GitHub Actions assigns a different CPU model.
