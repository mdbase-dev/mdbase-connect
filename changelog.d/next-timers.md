## Added

- The server can run the mdbase-next opaque timer service. It is off unless
  `MDBASE_NEXT_TIMERS=1`. Apps put, cancel, list and reconcile one-shot timers
  with their access token, under
  `/v1/next/collections/:collection/timers/:namespace`. The service stores only a
  timer ID, a criterion and a UTC time, plus optional `data` for hosted (cloud
  copy) collections. Each fired generation is one fired-timer event. Push and
  webhook delivery consume those events through the existing notification
  service.
- `next:timers copy-hosted` copies a hosted collection's active timers at
  cutover.
- Push channel targets (Web Push endpoints and keys, FCM tokens) can be sealed at
  rest with AES-256-GCM by setting `MDBASE_NEXT_PUSH_TOKEN_KEY` and
  `MDBASE_NEXT_PUSH_TOKEN_KEY_ID`. `next:timers seal-push-targets` seals
  existing rows. `unseal-push-targets` restores plaintext before rolling back to
  a release that predates sealing.
- Push channel registration and push and webhook delivery refuse grants on
  mdbase-next private-sync collections until device approval can be checked.
