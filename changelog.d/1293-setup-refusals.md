## Fixed

- Private collection setup no longer fails with "This collection changed" or "Changed somewhere else" when the review went stale before anything was written (for example right after sign-in). It reviews again once and applies if the person would see exactly the same changes; otherwise it shows "This collection changed" with the new review.
- A setup that only updates the collection's setup record (`mdbase.provisions.yaml`) now lists that change, instead of saying "Nothing in your collection will change".
