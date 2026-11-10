## Fixed

- Record writes now follow the collection's `settings.validation` (spec 04): at `warn` or `off` an invalid record is written and its issues reported, instead of every write being refused as `invalid_record` whatever the setting. Collections at `error` (the default) are unchanged.
- Writes can set their own validation level (`validation` in the SDK's write options, submit key 9), so a sync tool can carry invalid files instead of having them refused. Replicas from before this change ignore it and still refuse an invalid record.
