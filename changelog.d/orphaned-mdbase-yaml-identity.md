## Fixed

- Adding a folder whose `mdbase.yaml` carries an `x-mdbase-connect` identity that no mdbase Connect on this computer manages (a copied folder, one removed before the migration, or a computer without the old connector) no longer fails with `migration_pending` forever. mdbase now reads the YAML key instead of matching the text, so the key in a comment is ignored, and an orphaned identity is refused as `orphaned_legacy_identity` until you confirm removing only that key (`mdbase collection add --remove-legacy-identity`, or the confirmation in the desktop app) (#450).
