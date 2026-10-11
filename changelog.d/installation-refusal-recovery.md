## Fixed

- The device sign-in approval page no longer leaves people stuck after a refused step. Retryable failures offer Try again. When the chosen account can't be used for this sign-in, the page explains why in plain words and cancels the request, so the app stops waiting and can offer sign-in again. An app polling a cancelled request now gets `installation_pairing_denied` and can renew the request.
