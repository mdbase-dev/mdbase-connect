## Added

- Approve first-party installation access to named cloud-copy collections and an explicitly requested create capability. Created collections join only that installation's scope atomically; existing installations use additive same-device re-consent.
- Discover/join collections and read people only within approved UUIDs and current membership/enrolment. Explicit collection removal revokes the app's grants and enrolled installation devices without changing other collections or accounts.
