-- Device approvals of grants on private (end-to-end) synced collections, as reported by
-- the approving device and checked against the log (mdbase-next interface note
-- 2026-10-04-control-grant-approval-report.md). The approval itself is a sealed log
-- item; this row is what lets the control plane treat the grant as usable (timers,
-- channels, delivery). New table only.
CREATE TABLE next_grant_approvals (
  grant_id uuid PRIMARY KEY REFERENCES grants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES next_devices(id) ON DELETE CASCADE,
  approved_seq bigint NOT NULL,
  -- The v2 capability groups the user approved: the effective scope, never the grant
  -- row's full operations (SEC-046 §1).
  capabilities text[] NOT NULL,
  -- SHA-256 of the grant's terms when approved; a re-issued grant with other terms is
  -- not covered (SEC-046 §3).
  terms_digest bytea NOT NULL,
  signature bytea NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT now()
);
