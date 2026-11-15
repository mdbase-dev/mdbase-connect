## Fixed

- Open a collection after an app update moves one of its contracts to a versioned path and puts a newer contract at the old path. Setup used to write the older contract over the newer one, and from then on reported the collection as incompatible ("the managed resource was modified"). Setup now places each contract at the path its pack declares, and refuses a target remapping that would put two pack resources at one path.
