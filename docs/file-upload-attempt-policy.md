# File upload attempts and caller-owned recovery

`connection.files.upload()` and `uploadStream()` support two optional policies:

- `maxAttempts`: a finite integer from **1 to 10**, counting the first attempt,
  for each object upload part, framed upload chunk and commit. Set `1` to disable
  automatic retries of those upload writes. When omitted, existing defaults stay
  unchanged: **3** object part/commit attempts and **10** framed chunk attempts.
  This does not change download retry policy or request timeouts/concurrency.
- `noAutoAbort`: when `true`, do not automatically DELETE an incomplete transfer
  after failure. Use an explicit `transferId` if the caller needs to track that
  transfer for later recovery. When omitted or `false`, the existing policy stays
  unchanged: automatically abort an incomplete SDK-generated transfer; an
  explicitly caller-keyed transfer was already excluded from that cleanup.

```ts
const file = await connection.files.uploadStream(path, source, {
  transferId, // caller-generated UUID, retained before starting
  maxAttempts: 1,
  noAutoAbort: true,
});
```

These options are local SDK behavior, not file permissions or authority, and are
not sent as extra fields in file protocol requests. Existing approved add/replace
capabilities, source size/digest validation and original commit receipt validation
remain required. Successful calls return the actual accepted descriptor.

A rejected call without an original accepted descriptor can leave the remote
outcome **unknown**, including a commit whose response was lost. Single attempt
or suppressed cleanup does not prove no effect, rollback or receipt custody.
The caller must preserve its original attribution and follow its own recovery
policy; this option does not authorize replay or automatic adoption of later
metadata. Cleanup/recovery is the caller's responsibility when suppressed.
