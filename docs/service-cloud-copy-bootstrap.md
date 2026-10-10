# Shared service cloud-copy bootstrap

`features/next/service-cloud-copy.ts` owns the existing service-device generation,
service storage, genesis outbox registration, exact log readback and public reply
metadata for service-created cloud copies. It also supplies those same primitives
to the owner-device bootstrap/join path; no parallel migration creator is added.

Internal composition API:

```ts
createServiceCloudCopy(options, {
  collection, owner, runtime: "shadow" | "next", displayName,
  current: async (client) => { /* current authorized principal/claim */ }
})
```

The public service route hardcodes `next` and supplies its existing session/account
currentness callback. A migration caller will hardcode `shadow` and must supply its
current started-owner/source claim. There is no public runtime selector, migration
credential fallback or account-backend promotion in the helper. Suspensions and
accepted account/collection deletion remain the caller's authorization boundary.

Current-principal checks precede collection locks, service generation, outbox
registration, emitter work, log head reads and final metadata publication. No
network await holds the owner/collection transaction. Service keys are generated
only by the existing deployments and stored together with the same genesis outbox.
The first committed tuple wins; retry never substitutes newly generated identities.
Existing collections must match immutable owner/cloud-copy/root/runtime and still
be synced. Public new creation additionally respects legacy topology freezes.
Permanent collection deletion floors refuse before generation or final commit.

The result includes exact appended genesis bytes, public service identities and
observed log head only. It does not include target epoch keys, unwrapped private
service keys, record payloads or `verified`/`ready` flags. Native service activation,
keying, fresh FULL admission, migration source witness and gen0 readback are
separate qualifications; neither a row nor an HTTP response supplies readiness.

Tests use isolated local PostgreSQL and synthetic log/service peers. They exercise
public regressions and SHADOW tuple/retry/freeze/deletion boundaries, not managed
migration, custody or deployment. The dedicated migration target route is separate.
