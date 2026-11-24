## Added

- Emit main-thread `mdbase:open:stage:<stage>` performance marks from
  `@mdbase-dev/sdk` for every `AppOpeningProgress` stage transition, and update
  `scripts/app-timings` to compute per-stage durations from those marks instead
  of scraping opening-screen DOM text.
