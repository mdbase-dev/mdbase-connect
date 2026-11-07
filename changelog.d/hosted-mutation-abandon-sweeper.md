## Fixed

- The hosted provider now closes mutations left `prepared` by a crashed request handler. Once a request's lease has been expired for more than a day, the provider's maintenance loop records a final `mutation_abandoned` receipt, so recovering the request ends instead of staying pending. Record, type, view and setup changes report `application: "not_applied"`. Timer changes report `application: "unverified"`, and the app should send its current desired timers as a new request.
- Taking over an expired `put_timer`, `reconcile_timers` or unguarded `cancel_timer` request no longer re-runs the old input, which could overwrite a newer timer change. The request is abandoned with an `unverified` receipt instead.
