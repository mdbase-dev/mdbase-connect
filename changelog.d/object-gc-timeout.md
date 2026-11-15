## Fixed

- The scheduled object sweep (`MDBASE_NEXT_OBJECT_GC=1`) gives each `gc` batch five minutes instead of the ten seconds other log-service calls get, so a collection with a backlog of deleted files is no longer abandoned on a timeout every sweep.
