## Fixed

- The production desktop daemon now embeds the reviewed production trust asset
  (`config/next-trust/production.json`), pinned by its SHA-256 and verified at
  load, so synced collections and turning on sync no longer refuse with
  `trust_missing`. LAB and local rehearsal builds are unchanged and still embed
  no production trust.
