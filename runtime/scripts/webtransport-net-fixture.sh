#!/usr/bin/env bash
# Invoked by qualify-webtransport.sh inside bubblewrap AND a new user/network namespace.
# The test driver and daemon share the host end. Chrome starts in the peer namespace.
set -euo pipefail
[[ $HOME == /tmp/qualification-home && -z $(ip route show) ]]
[[ $(ip -o link show | wc -l) == 1 && $(ip -o link show lo | wc -l) == 1 ]]
ip link set lo up
unshare --net sh -c 'touch /tmp/browser-net-ready; exec sleep infinity' &
peer=$!
trap 'kill "$peer" 2>/dev/null || true; wait "$peer" 2>/dev/null || true' EXIT
until [[ -f /tmp/browser-net-ready ]]; do kill -0 "$peer"; sleep 0.02; done

ip link add wt-host type veth peer name wt-browser
ip link set wt-browser netns "$peer"
ip addr add 192.168.88.1/30 dev wt-host
ip link set wt-host up
nsenter --target "$peer" --net -- ip addr add 192.168.88.2/30 dev wt-browser
nsenter --target "$peer" --net -- ip link set wt-browser up
nsenter --target "$peer" --net -- ip link set lo up
nsenter --target "$peer" --net -- ip route get 192.168.88.1 >/dev/null
ip route get 192.168.88.2 >/dev/null

export WT_BROWSER_PEER=$peer
export WT_REAL_CHROME=$CHROME_BIN
export CHROME_BIN=/tmp/veth-chrome
cat > "$CHROME_BIN" <<'LAUNCH'
#!/bin/sh
exec nsenter --target "$WT_BROWSER_PEER" --net -- setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- "$WT_REAL_CHROME" "$@"
LAUNCH
chmod 700 "$CHROME_BIN"
"$@"
