## Fixed

- Enforce the account's effective synced-collection allowance for next-runtime creation, including cloud copies, Private sync and starter collections. Concurrent creates cannot exceed the limit; deleting a collection frees a slot. Existing collections remain accessible even if an account is already over its allowance.
