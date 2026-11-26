## Fixed

- Hosted replicas no longer rescan every record after unrelated resource writes. Catalog repairs resume across wakes, rewrite only changed record metadata, and log count-only start and finish events.
