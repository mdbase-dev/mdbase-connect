## Added

- Next desktop and CLI devices can explicitly retire a matching legacy local connector after takeover. Retirement requires the exact positive registered inventory, preserves collection, grant and rollback-binding rows, and refuses connectors already registered as next devices. Enrollment, inventory and retirement serialize against current account and connector credentials; retirement does not activate grants, rotate keys or change the account backend.
