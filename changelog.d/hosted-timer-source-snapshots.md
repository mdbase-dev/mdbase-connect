## Fixed

- Replace lossy hosted timer export with bounded, frozen, SELECT-only keyset
  pages preserving original identity, generation, terminal state and timestamps.
  Refuse unsettled or unrepresentable records instead of silently skipping them.
- Close the legacy `copy-hosted` CLI path until strict original-timer import and
  authenticated page consumption are integrated, preventing generation resets,
  omitted pages and replay of previously delivered reminders.
