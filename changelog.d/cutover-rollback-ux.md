## Fixed

- After an account's upgrade is paused and returned to mdbase Connect, app sign-in windows now close with a plain explanation instead of asking people to wait and try again. Installation pairing reports the new `postponed` upgrade state.
- The legacy SDK keeps the stored authorization when a token refresh fails for a reason other than the credential (for example a collection being upgraded, a rate limit or an outage), and reports it as temporarily unavailable. Only genuine authorization failures remove it.
- The "collection is being upgraded" message no longer claims changes are safe; it says changes made during the upgrade may not be saved and to check them afterwards.
- Desktop no longer offers "Move to the new sync engine" before the server allows the move, shows why a move was refused, and explains when this computer moved its collections but the account still uses mdbase Connect. The bundled daemon refuses an explicit move the rollout check does not allow, before stopping the old connector.
