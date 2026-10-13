## Fixed

- The hosted migration executor's claim challenge and claim read calls to the control plane are now rate limited per service (4,800 requests a minute per route) when they carry the hosted service credential, instead of 20 requests a minute per IP address, so collections migrating behind shared egress addresses are no longer throttled. Requests without the credential keep the per-IP limit.
