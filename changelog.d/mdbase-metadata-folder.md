## Changed

- New collections keep type and contract definitions under `_mdbase/`, with a README explaining the folder. Pack schemas follow the configured contracts folder; existing collection layouts and spec defaults stay unchanged.

- Projection rebuilds quarantine records with missing encrypted payloads even when other records follow them.
