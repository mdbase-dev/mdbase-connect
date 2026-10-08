## Changed

- Synced next-runtime application approvals and permission changes now queue exact, non-broadening policy grants transactionally. Narrowing rotates the immutable log grant ID, and all SQL revocation/deletion paths queue its revocation atomically. Noise discovery returns the current log identity plus the stable Connect authorization reference; private approval reports bind to the current log identity.
