## Fixed

- Hosted collections now read back the own-change history they store, so the repair history budget counts it and lost-change recovery can use it. Previously the hosted store wrote these rows but reported none (#1083).
