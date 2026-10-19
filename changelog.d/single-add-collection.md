## Changed

- Offer one “Add a collection…” action in the shared collection gate and switcher, using the SDK chooser, coordinated with its hosted/Private picker update. Keep the legacy `allowPrivate` presentation option as a deprecated no-op and `addPrivateCollection` UI action as a deprecated alias of normal Add; leave guards, gesture-bound calls, cancellation and save warnings are unchanged. This does not add new Private collection creation.
