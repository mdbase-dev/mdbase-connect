## Added

- The server can push the aggregate usage report for the 1, 7, 30 and 90 day windows to the operations metrics ingest at 00:40, 06:40, 12:40 and 18:40 UTC, from one instance at a time, when `OPS_METRICS_INGEST_URL` and `OPS_METRICS_INGEST_TOKEN` are set in production. The pushed body omits the per-signup `beta.recent_signups` list. An incomplete or unusable configuration leaves the push off with a startup warning and never stops the server starting.
