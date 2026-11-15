## Added

- Operators can write and send one-off announcement emails without a deployment. `auth-admin announcements create` stores the subject and body as a new version, optionally with a separate body for accounts that joined during the beta, and links written as `[text](https://…)` show as their text; `show --user` prints exactly what one account would get, `test-send` sends the latest version to one account, and `schedule --all enabled` sends it once to every account. The announcements preference, unsubscribe link and suppressions apply as for other account email.
