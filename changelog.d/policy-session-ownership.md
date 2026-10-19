## Fixed

- Keep policy emission and recovery serialized without holding SQL transactions
  across log-service calls. Fence writes and append decisions on the same owned
  database session; a disconnected sender cannot acknowledge an uncertain batch
  after another worker takes over. Preserve original retry bytes, recovery order,
  atomic loss scheduling and database timeouts.
