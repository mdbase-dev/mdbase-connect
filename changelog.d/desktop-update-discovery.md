## Fixed

- Desktop update checks no longer use GitHub's REST API, so they no longer fail with HTTP 403 when other traffic behind the same public IP has used up its 60 unauthenticated requests an hour. Release tags come from one git `ls-refs` request and the signed channel document from release download URLs; only the newest published release is verified, so a check takes seconds instead of up to a minute (#1379).
- The Desktop app's first automatic update check runs 30 seconds after launch instead of 30 seconds after the daemon finishes starting (#1284).
- When `mdbase service install`, `start` or `status` fails, the Desktop start-up error now includes the CLI's own message, for example which `systemctl --user` call failed on a system without a user systemd session, instead of only the exit code (#1283).
