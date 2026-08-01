# Functional stress regressions

Each JSON file fixes a seed and workload that must remain reproducible. A
confirmed stress failure should be minimized, copied here, and given expected
record and action digests after the defect is fixed.

Run every retained trace with:

```bash
pnpm test:stress-regressions
```

Per-run traces, logs, and snapshots are written under `.tmp/stress-failures/`
and remain untracked.
