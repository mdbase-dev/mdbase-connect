## Fixed

- The remaining migration-token routes the hosted migration executor and Driver call (fence, source, target, claim read, source-witness, the replica and member/cutover policy steps, and cutover) now count requests carrying the migration token against a per-route service budget of 4,800 a minute instead of the shared per-IP 20 a minute, matching the migration-claim routes. Requests without the token or with a wrong one keep the per-IP limit.
