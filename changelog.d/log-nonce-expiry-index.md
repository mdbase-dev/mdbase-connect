## Changed

- The log service no longer keeps an `expires_at` index on used HTTPS nonces. Replay refusal still uses the nonce primary key, and each signed RPC writes fewer rows.
