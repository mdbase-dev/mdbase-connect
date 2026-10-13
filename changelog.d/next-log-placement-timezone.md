## Changed

- Collections created on mdbase-next are stored in the region nearest their owner. A new collection uses the timezone its owner's device reported at sign-up; a migrated collection uses its hosted collection's timezone, falling back to the owner's other hosted collections. Without a timezone the log service's default region applies.
