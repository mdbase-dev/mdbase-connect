## Fixed

- Guard runtime writes against incomplete restored key history, and retain permanently refused changes on the device with a rejected receipt instead of retrying them after reload. The SDK write ledger identifies the failed change and its recovery action.
- Release the file-upload lane when cancellation races commit, without discarding an already captured write, so Stop does not block the next upload.
