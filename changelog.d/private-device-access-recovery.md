## Fixed

- Let "Request access again" restore an app's access to a Private collection it kept on its own device. Connect now offers that one collection with the same per-collection consent as at first sign-in, instead of failing with "needs an update". After unlocking with the encryption password, sync resumes in the same app. When the server can't give the key back, the app says "This app can't keep this collection".
- Requesting access again after declining it in the portal no longer stops the app with "Reload required". The SDK now accepts the renewed window while the same account is chosen again, and ignores a late call for the approval window the new request replaced.
