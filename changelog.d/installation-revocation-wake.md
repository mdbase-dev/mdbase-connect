## Fixed

- Removing an app's collection access, removing an installation, or signing an installation out now delivers the device revocation to the collection log immediately instead of waiting for the next background policy poll. Previously a revoked installation could keep writing until that poll reached the collection.
