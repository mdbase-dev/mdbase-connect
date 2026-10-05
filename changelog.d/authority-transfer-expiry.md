## Fixed

- Serialize authority-transfer expiry with current state and deadline checks before
  provider cleanup. Preserve renewed imports and in-flight activation, and apply
  promotion cleanup only to the winning transition and its exact candidates.
- Account overview and hosted control reads no longer run transfer cleanup. Hosted
  expiry runs in bounded background batches. Update Connect and its hosted provider
  together; an older provider leaves expiry pending rather than falling back to
  ordinary cancellation. Explicit user cancellation remains available.
