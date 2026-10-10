#!/usr/bin/env bash
# Isolated desktop Obsidian for the obsidian-runtime e2e suite (Linux).
# Never touches the user's Obsidian, ~/.config/obsidian, its CLI socket or ~/notes:
# own HOME/XDG dirs, own --user-data-dir, private XDG_RUNTIME_DIR (Obsidian
# unlinks and rebinds $XDG_RUNTIME_DIR/.obsidian-cli.sock), no D-Bus, xvfb.
#
#   desktop.sh setup <vault> [plugin-copies]   create a disposable vault with the e2e plugin
#   desktop.sh start <vault>                   launch; CDP on 127.0.0.1:$PORT
#   desktop.sh kill9 | stop | pids
#
# APP defaults to .work/app-1.13.7/obsidian (extract an AppImage there with
# --appimage-extract). Override VERSION=1.12.7 to use .work/app-1.12.7.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$HERE/.work"
VERSION="${VERSION:-1.13.7}"
APP="$WORK/app-$VERSION/obsidian"
PROFILE="$WORK/profile-$VERSION"
PORT="${PORT:-9372}"
PLUGIN="$HERE/plugin"
cmd="${1:-}"; shift || true
tree() { local p=$1; [ "$p" = 0 ] && return; [ -d /proc/$p ] || return; echo $p; for c in $(pgrep -P $p); do tree $c; done; }
case "$cmd" in
  setup)
    v="$1"; copies="${2:-1}"; V="$WORK/vaults/$v"
    ids=()
    for i in $(seq 1 "$copies"); do
      id="mdbase-runtime-e2e"; [ "$i" -gt 1 ] && id="mdbase-runtime-e2e-$i"
      mkdir -p "$V/.obsidian/plugins/$id"
      cp "$PLUGIN/main.js" "$V/.obsidian/plugins/$id/"
      sed "s/\"id\": \"mdbase-runtime-e2e\"/\"id\": \"$id\"/" "$PLUGIN/manifest.json" > "$V/.obsidian/plugins/$id/manifest.json"
      ids+=("\"$id\"")
    done
    (IFS=,; echo "[${ids[*]}]") > "$V/.obsidian/community-plugins.json"
    [ -f "$V/README.md" ] || echo "# disposable e2e vault ($v)" > "$V/README.md" ;;
  start)
    v="$1"
    [ -x "$APP" ] || { echo "missing $APP"; exit 1; }
    python3 - "$PROFILE" "$WORK/vaults" "$v" <<'PY'
import json, sys, os, hashlib, time
prof, vaults, open_v = sys.argv[1:4]
reg = {}
for name in sorted(os.listdir(vaults)):
    vid = hashlib.md5(name.encode()).hexdigest()[:16]
    reg[vid] = {"path": os.path.join(vaults, name), "ts": int(time.time()*1000), **({"open": True} if name == open_v else {})}
for d in [prof, os.path.join(prof, "xdg", "obsidian")]:
    os.makedirs(d, exist_ok=True)
    json.dump({"vaults": reg, "updateDisabled": True}, open(os.path.join(d, "obsidian.json"), "w"))
PY
    H="$PROFILE/home"; mkdir -p "$H/.config" "$H/.cache" "$H/.local/share" "$PROFILE/rt" "$WORK/shim"; chmod 700 "$PROFILE/rt"
    # No-op xdg shims so setAsDefaultProtocolClient can't touch mimeapps.list.
    for s in xdg-mime xdg-settings xdg-open xdg-desktop-menu; do printf '#!/bin/sh\nexit 0\n' > "$WORK/shim/$s"; chmod +x "$WORK/shim/$s"; done
    env -i PATH="$WORK/shim:$PATH" HOME="$H" XDG_CONFIG_HOME="$PROFILE/xdg" XDG_CACHE_HOME="$H/.cache" XDG_DATA_HOME="$H/.local/share" \
      XDG_RUNTIME_DIR="$PROFILE/rt" DBUS_SESSION_BUS_ADDRESS=disabled: LANG=en_US.UTF-8 \
      setsid nohup xvfb-run -a -s "-screen 0 1400x900x24" "$APP" --no-sandbox \
      --user-data-dir="$PROFILE/xdg/obsidian" --remote-debugging-port="$PORT" --remote-debugging-address=127.0.0.1 \
      --password-store=basic --ozone-platform=x11 \
      > "$WORK/obsidian-$v.log" 2>&1 < /dev/null &
    echo $! > "$WORK/xvfb-run.pid"
    for i in $(seq 1 90); do curl -s --max-time 2 "127.0.0.1:$PORT/json/list" | grep -q app://obsidian.md && break; sleep 0.5; done
    curl -s --max-time 3 "127.0.0.1:$PORT/json/list" | python3 -c 'import json,sys; [print(t["type"], t["url"][:80]) for t in json.load(sys.stdin)]' ;;
  pids)
    set +e; tree "$(cat "$WORK/xvfb-run.pid" 2>/dev/null || echo 0)" ;;
  kill9)
    set +e
    root=$(cat "$WORK/xvfb-run.pid" 2>/dev/null || echo 0)
    pids=$(for p in $(tree "$root"); do [ "$p" != "$root" ] && echo $p; done)
    # Only processes of THIS instance: launched from our extracted app path.
    for p in $(pgrep -f "$WORK/app-"); do pids="$pids $p"; done
    [ -n "${pids// }" ] && kill -9 $pids 2>/dev/null
    sleep 1; rest=$(tree "$root"); [ -n "$rest" ] && kill -9 $rest 2>/dev/null; true ;;
  stop)
    set +e
    for p in $(pgrep -f "^$APP --no-sandbox"); do kill $p; done
    sleep 3; "$0" kill9 ;;
  *) echo "usage: $0 setup|start|kill9|stop|pids"; exit 1 ;;
esac
exit 0
