-- Ephemeral, signed opaque candidate metadata. Never approval/key delivery.
CREATE TABLE next_device_approval_peers (
  id uuid PRIMARY KEY,
  collection_id uuid NOT NULL REFERENCES next_collections(collection_id) ON DELETE CASCADE,
  approver_device uuid NOT NULL REFERENCES next_devices(id) ON DELETE CASCADE,
  requester_device uuid NOT NULL REFERENCES next_devices(id) ON DELETE CASCADE,
  sender_device uuid NOT NULL REFERENCES next_devices(id) ON DELETE CASCADE,
  recipient_device uuid NOT NULL REFERENCES next_devices(id) ON DELETE CASCADE,
  generation bytea NOT NULL CHECK (octet_length(generation) = 32),
  kind integer NOT NULL CHECK (kind IN (0, 1)),
  envelope bytea NOT NULL CHECK (octet_length(envelope) BETWEEN 1 AND 2048),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  CHECK (approver_device <> requester_device),
  CHECK ((kind = 0 AND sender_device = approver_device AND recipient_device = requester_device)
      OR (kind = 1 AND sender_device = requester_device AND recipient_device = approver_device)),
  UNIQUE (collection_id, approver_device, requester_device, generation, kind)
);
CREATE INDEX next_device_approval_peers_inbox ON next_device_approval_peers(recipient_device, collection_id, expires_at);
CREATE INDEX next_device_approval_peers_sender ON next_device_approval_peers(sender_device, expires_at);
