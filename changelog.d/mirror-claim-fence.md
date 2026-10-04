## Security

- Hosted mirrors now re-check the folder's `.mdbase/connect-role.json` marker
  before every sync. If a newer mdbase runtime has claimed the folder (a v2 or
  later marker), the mirror stops with `collection_claimed_by_newer_runtime`
  instead of uploading the folder's changes, and `mirror remove` leaves that
  marker in place. Previously a running mirror kept syncing a claimed folder
  and removal deleted the claim.
