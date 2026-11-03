## Security

- Confirm native Viewer role changes only after their read-only policy reaches the log. Failed or uncertain publication now returns the existing retryable sharing-unavailable error instead of reporting success while queued writes can still be accepted. Ordinary upgrades and renewable Viewer device tokens retain their existing behavior.
