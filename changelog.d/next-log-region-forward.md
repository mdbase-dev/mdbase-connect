## Changed

- A collection's hosted copy on mdbase-next is created in the same region as its log. Connect records the region the log service chose when it created the log and passes it to the hosted service when the collection is activated or admitted for migration. Collections without a region keep the hosted service's default.
