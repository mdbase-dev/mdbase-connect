## Changed

- Query results whose order terms all compare equal now come back in ascending
  `file.path` order (Unicode code-point order) in both ascending and descending
  queries, as the mdbase spec requires. They were ordered by internal record ID.
  A rename moves a record among its ties. The first open after upgrading rebuilds
  each collection's query field index once (store schema 2); a runtime older than
  this change refuses to open a store that has been upgraded.
