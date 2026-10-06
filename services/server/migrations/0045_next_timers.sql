-- mdbase-next opaque timer service (mdbase-next docs/contracts/timer-service-api.md).
-- Additive only: the previous release never reads these tables or columns.
CREATE TABLE next_timers (
  grant_id uuid NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  namespace text NOT NULL,
  timer_id text NOT NULL,
  criterion_id text NOT NULL,
  fire_at timestamptz NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'firing', 'fired', 'cancelled')),
  data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  fired_at timestamptz,
  PRIMARY KEY (grant_id, namespace, timer_id)
);
CREATE INDEX next_timers_due_idx ON next_timers(status, fire_at);
CREATE INDEX next_timers_grant_idx ON next_timers(grant_id, status);

-- The fired-timer event: the single output of the timer service. One row per
-- fired generation; data follows mdbase.runtime.timer.fired@1.0.0. `data` is
-- non-null only for cloud-copy collections.
CREATE TABLE next_timer_events (
  event_id text PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  criterion_id text NOT NULL,
  namespace text NOT NULL,
  timer_id text NOT NULL,
  generation bigint NOT NULL,
  scheduled_for timestamptz NOT NULL,
  fired_at timestamptz NOT NULL,
  late_by_ms bigint NOT NULL,
  data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX next_timer_events_created_idx ON next_timer_events(created_at);

-- Per-consumer receipts, written in the same transaction as the consumer's effect.
CREATE TABLE next_timer_event_receipts (
  consumer text NOT NULL,
  event_id text NOT NULL REFERENCES next_timer_events(event_id) ON DELETE CASCADE,
  handled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
