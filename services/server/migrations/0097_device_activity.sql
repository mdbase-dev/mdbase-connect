-- Native sync reaches the log directly, so it leaves no access token or protocol
-- telemetry behind. A device's log-token refresh is its one recurring control-plane
-- request, and these tables keep that much for the operator usage report: which day
-- a connector refreshed, and the last day any device refreshed for a collection.
-- The two are deliberately unjoined: no history of who used which collection, and no
-- request, operation, path or content identifier. pruneUsageHistory bounds the days.
CREATE TABLE device_activity_days (
  connector_id uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  day date NOT NULL,
  PRIMARY KEY (connector_id, day)
);
CREATE INDEX device_activity_days_day ON device_activity_days (day);

CREATE TABLE next_collection_activity (
  collection_id uuid PRIMARY KEY REFERENCES next_collections(collection_id) ON DELETE CASCADE,
  last_active_on date NOT NULL
);
