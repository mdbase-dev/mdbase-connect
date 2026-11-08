## Fixed

- The account page showed hosted retained file storage as full: `GET /v1/me` reported the retained file limit as `subscription.usage.retained_file_bytes`. The hosted provider now nests account limits under `limits` in its account usage response, so usage and limit no longer share a key. Enforcement was unaffected.
