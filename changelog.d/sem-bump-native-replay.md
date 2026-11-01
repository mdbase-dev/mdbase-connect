## Fixed

- Replay native Markdown and file-to-record entries written under a newer semantics version with the same structural checks as earlier versions, so replicas that have not updated yet keep syncing through a semantics bump. When this build's planner disagrees with an entry of its own semantics version, the replica still stops for an update, and now also reports a verification mismatch.
