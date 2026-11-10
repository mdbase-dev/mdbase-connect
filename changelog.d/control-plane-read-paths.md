## Changed

- The control plane reads policy history, grants and tokens through new
  indexes (migration `0102_control_plane_read_indexes`), so device, membership
  and enrolment checks, grant revocation and collection deletion no longer scan
  whole tables. The migration only adds indexes; the previous server release
  runs unchanged beside it.
- The account overview (`GET /v1/me`) and an app's collection list
  (`GET /v1/next/apps/collections`) make a fixed number of database reads
  instead of several per collection or grant. The account overview no longer
  lists grants whose revocation is complete unless they ask for
  reauthorization; the portal never showed them.
