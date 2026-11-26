## Fixed

- Retrying sign-in after an approval request expired no longer fails with `binding`: the renewed request waits for the portal to confirm the account again instead of keeping the old confirmation.
- Native app shells (an opener that returns to a private-use scheme) no longer stop their runtime when the OS freezes and thaws the app, which lost a waiting approval. When the approval page sends the person back to the app, the SDK finishes the app's part (attestation and any Private collection authorization) and then shows the same approval page again.
