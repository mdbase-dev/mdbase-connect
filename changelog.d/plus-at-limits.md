## Changed

- Point people at Plus where they hit a Free plan limit: the synced collection limit message, the SDK's "Out of storage" message and a new desktop note when a collection's storage is full now mention upgrading to Plus from the mdbase account page.
- Tell an invited person whose invitation can't be accepted because the owner has no member seats left to ask the owner to upgrade to Plus or remove someone, and show owners a "No member seats left" note with an Upgrade to Plus link in People & sharing.
- Report the member seats an account uses as `subscription.usage.collection_member_seats` in `/v1/me`.
- Stop listing a largest-file size on the account page: native collections don't enforce a per-file limit, and storage is the limit that applies.
