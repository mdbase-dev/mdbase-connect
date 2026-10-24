## Fixed

- A Private collection can now be opened on a second computer. The computer that already has it shows "<computer> wants to open <collection>" with Allow and Deny in the desktop app, and `mdbase device pending`, `mdbase device approve <id>` and `mdbase device deny <id>` do the same from the command line. After a visual check that the six-digit code shown on both computers matches, one Allow completes the approval; nothing is typed. Deny survives a restart, and unanswered requests renew automatically. Approval is still never possible from a third-party app.
