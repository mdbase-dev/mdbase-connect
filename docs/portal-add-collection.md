# One Add collection entry

The collections page always offers **Add collection**. Its one location choice
lists **On this computer** when the current account owns a linked, non-revoked
Native desktop/CLI registration, and **Hosted** only when Hosted is enabled.
Another account's devices and application runtimes never enable Native creation.
With both choices available, the user chooses explicitly; the portal does not
silently switch authorities. With neither, it explains how to connect a computer.

Native uses the existing `mdbase-connect://open` desktop handoff. Folder selection,
collection keys and signed genesis remain on the device. The portal neither
creates a Native collection nor borrows Hosted credentials for it. Hosted keeps
the immutable account creation intent from #820 and the existing canonical
service/legacy creator. The browser stores the original account, request UUID,
name and timezone before the POST. An uncertain outcome locks Location and the
name until that same request resolves; it cannot become a Native handoff.

Private badges say **On <exact computer name>** or **On <name>: offline**.
The metadata projection uses the canonical own-device enrollment filter:
appended exact account/device/key tuples, non-revoked connectors and no device
or member revocation. A different online computer never stands in for the
enrolled computer. With no matching computer the badge says **Computer not
connected**. Cloud copies say **Hosted**. Existing connector presence is reused;
there is no new polling, content-readiness or Effective inference.

Completed migrated accounts use the canonical next-account migration guard,
not a cleared archive freeze. The real PostgreSQL suite demonstrates accepted
archive/start/flip completion, pre-completion refusal and original-intent retry.
It also constructs an actual migration directory through 0081 without 0076,
then proves the standard runner fills that gap, preserves every existing ledger
entry/checksum, enforces the intent trigger and is idempotent. Applied migration
bytes are unchanged; 0076 is retained on that evidence.
