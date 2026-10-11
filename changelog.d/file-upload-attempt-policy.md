## Added

- File uploads accept a bounded `maxAttempts` option and `noAutoAbort` for caller-managed recovery. Existing retry and cleanup defaults remain unchanged; callers can choose a single attempt without automatically deleting an incomplete transfer.
