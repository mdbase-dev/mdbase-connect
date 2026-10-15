## Fixed

- Fixed migration archive acceptance refusing a full-size cohort: the acceptance request (membership plus every ordered source fence) is now bounded at 1 MiB instead of 4 KiB. Freeze and start requests remain bounded at 4 KiB.
