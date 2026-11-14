-- The Plus plan, sold as a Stripe subscription. Its numbers are provisional until
-- the cost re-measure (due about 2026-11-17) and live only here: 100 GiB of files
-- (retained twice that, like free_v1), 10 synced collections, 250 MiB per file and
-- 5 member seats. Replicas, document size and files per collection match free_v1
-- and operator_v1. Effective entitlements are the per-field maximum across grants,
-- so a Plus grant only ever raises an account's limits.
INSERT INTO entitlement_profiles
  (code, hosted_storage_bytes, retained_file_bytes, max_document_bytes,
   max_single_file_bytes, max_mirror_replicas_per_collection,
   max_application_replicas_per_collection, max_hosted_collections,
   max_files_per_collection, max_collection_member_seats)
VALUES
  ('plus_v1', 107374182400, 214748364800, 2097152, 262144000,
   10, 50, 10, 10000, 5);

-- The Stripe customer each account checks out as, created on its first checkout.
CREATE TABLE billing_customers (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The last state read from Stripe for each Plus subscription, for the portal. The
-- entitlement itself is the account_entitlement_grants row with source
-- 'subscription' and the subscription id as source_reference.
CREATE TABLE billing_subscriptions (
  stripe_subscription_id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL,
  current_period_end timestamptz NOT NULL,
  -- When a scheduled cancellation ends the subscription; null while it renews.
  cancels_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX billing_subscriptions_user_idx ON billing_subscriptions(user_id);
