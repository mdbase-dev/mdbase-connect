## Fixed

- Hosted and escrow deployments' authenticated calls to the control plane's internal routes are now rate limited per service (12,000 requests a minute) instead of sharing the per-IP limit (600 a minute) with public traffic, so many hosted collections behind shared egress addresses no longer receive 429 responses. Requests without a valid service token keep the per-IP limit.
