## Changed

- Release changed desktop clients automatically from qualified main commits,
  using CI-allocated beta versions and signed 10%, 50%, then 100% staged updates
  with a release-owner stop switch and production contract compatibility checks.
- Refuse desktop publication before allocating a tag while immutable release
  assets conflict with widening; require an explicit owner channel-policy decision.
