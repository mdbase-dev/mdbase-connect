## Added

- `MDBASE_NEW_ACCOUNT_BACKEND=legacy|next` (default `legacy`) selects the
  backend of newly created accounts: OAuth sign-up, email sign-up and
  invitation acceptance. Set it to `next` at the all-user cutover so new
  sign-ups can use the new apps at once.
  - A `next` account is created fully flipped: the backend marker, a flip
    record with no collections and the flip audit event, written by the same
    code as the staged migration's flip.
  - The installation sign-in page shows the "mdbase was upgraded" notice only
    to migrated accounts, not to accounts created on the new backend.
