## Fixed

- Prevent local CLI batches from timing out with `outcome_unknown` when background
  filesystem ingestion overlaps durable settlement. Runtime background writes now
  share the collection mutation permit; exact revisions, recovery behavior, and
  operation deadlines are unchanged.
