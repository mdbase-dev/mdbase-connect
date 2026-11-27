## Added

- The runtime validates `format: local-date-time` and uses the collection’s `settings.timezone` to compare and sort floating date-times alongside instants. Collections without a zone keep floating values as strings and report a `timezone_required` warning.
