## Changed

- LAB hosted Worker logs now include one `hosted_invocation` line per alarm and per activation, tagged with the salted collection tag. It records the applied position, the log head heard of, how many items the invocation applied, whether the copy is serving, caught up or installing, whether a key grant is waiting or due, and the next wakeup and stored alarm as millisecond deltas. LAB `hosted_engine_reset` and `hosted_record_meta_repair_*` lines carry the same tag (#1850). Production logs are unchanged.
