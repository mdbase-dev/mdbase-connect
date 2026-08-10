ALTER TABLE hosted_provider_replicas
  ADD COLUMN IF NOT EXISTS operation_transport_protocol integer,
  ADD COLUMN IF NOT EXISTS operation_transport_recovery_protocols integer[] NOT NULL DEFAULT '{}';

ALTER TABLE hosted_provider_replicas
  DROP CONSTRAINT IF EXISTS hosted_provider_replicas_operation_transport_check;

ALTER TABLE hosted_provider_replicas
  ADD CONSTRAINT hosted_provider_replicas_operation_transport_check CHECK (
    (purpose = 'mirror'
      AND operation_transport_protocol IS NULL
      AND cardinality(operation_transport_recovery_protocols) = 0)
    OR
    (purpose = 'application'
      AND (
        -- Rows created before beta57 remain temporarily unbound and accept
        -- either frozen transport until the control plane patches the exact
        -- signed grant contract. New API writes never create this state.
        (operation_transport_protocol IS NULL
          AND cardinality(operation_transport_recovery_protocols) = 0)
        OR
        (operation_transport_protocol IN (2, 3)
          AND operation_transport_recovery_protocols <@ ARRAY[2, 3]::integer[]
          AND NOT operation_transport_protocol = ANY(operation_transport_recovery_protocols))
      ))
  );
