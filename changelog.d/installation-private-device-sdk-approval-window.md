## Fixed

- SDK: an application sign-in no longer ends as blocked when the person closes the approval window before the app has read the approval. The application Worker's next message for that window was treated as a protocol fault and stopped the app; it is now declined and the sign-in finishes from the receipt.
