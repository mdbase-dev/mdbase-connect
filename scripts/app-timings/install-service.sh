#!/bin/sh
# Run with sudo on the dedicated VM after copying the suite and private config.
set -eu
runner_user=${1:?usage: install-service.sh RUNNER_USER}
id "$runner_user" >/dev/null
case "$runner_user" in *[!a-zA-Z0-9_-]*|'') exit 2;; esac
for path in config.json prod-big-portal.json timings-token; do
  test -f "/opt/app-timings/$path"
  chmod 0600 "/opt/app-timings/$path"
done
sed "s/RUNNER_USER/$runner_user/" "$(dirname "$0")/app-timings.service" > /etc/systemd/system/app-timings.service
systemd-analyze verify /etc/systemd/system/app-timings.service
systemctl daemon-reload
systemctl enable app-timings.service
