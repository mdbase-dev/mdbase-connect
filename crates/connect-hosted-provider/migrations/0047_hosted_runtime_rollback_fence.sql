-- Durable admission fencing closes the race between a rollback preflight and
-- a query that would otherwise create a newer cursor immediately afterward.
-- Release requests intentionally bypass this gate so clients can drain.
CREATE TABLE hosted_provider_runtime_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  query_admission_suspended boolean NOT NULL DEFAULT false,
  suspension_reason text CHECK (
    suspension_reason IS NULL OR length(suspension_reason) BETWEEN 1 AND 512
  ),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (query_admission_suspended OR suspension_reason IS NULL)
);

INSERT INTO hosted_provider_runtime_control (singleton)
VALUES (true);
