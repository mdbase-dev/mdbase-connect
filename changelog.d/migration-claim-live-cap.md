## Fixed

- Keep hosted migration claim issuance available across sequential authenticated reads by counting only unconsumed, unexpired challenges against the subject cap. One-live-nonce enforcement, expiry, proof scope and atomic consumption are unchanged.
