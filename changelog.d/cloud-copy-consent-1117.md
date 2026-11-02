## Fixed

- Consent now offers cloud-copy collections while the owner's computers are offline, and approving one creates a grant served by the collection's hosted copy and, while one is online, by the owner's computers. Applications that require an mdbase cloud collection are offered cloud copies too. Grants on synced collections record the mode they were approved for; changing a collection's mode revokes its grants for the other mode, including in the collection's log. ([#1117](https://github.com/mdbase-dev/mdbase-connect/issues/1117))
