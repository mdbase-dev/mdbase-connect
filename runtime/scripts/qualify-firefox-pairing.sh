#!/usr/bin/env bash
# Run with a built CLI, direct Editor dist and its compiled HTTPS origin.
# Uses stock /usr/bin/firefox, bubblewrap, Xvfb and Node 22+. Everything writable is disposable.
set -euo pipefail
[[ $# -eq 3 ]] || { echo "Usage: $0 <mdbase> <editor-dist-direct> <https-origin>" >&2; exit 2; }
ulimit -c 0
exec bwrap --die-with-parent --unshare-net --unshare-pid --unshare-ipc --unshare-uts \
  --ro-bind /usr /usr --ro-bind /etc /etc --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib /lib64 \
  --proc /proc --dev /dev --tmpfs /dev/shm --tmpfs /tmp --tmpfs /run --dir /tmp/.X11-unix --dir /tmp/home \
  --ro-bind "$(realpath "$(command -v node)")" /node --ro-bind "$(realpath "$1")" /mdbase --ro-bind "$(realpath "$2")" /dist \
  --ro-bind "$(realpath "$(dirname "$0")/qualify-firefox-pairing.mjs")" /driver.mjs \
  --clearenv --setenv HOME /tmp/home --setenv PATH /usr/bin:/bin --setenv LANG C.UTF-8 --chdir /tmp \
  --setenv LIBGL_ALWAYS_SOFTWARE 1 --setenv __EGL_VENDOR_LIBRARY_FILENAMES /usr/share/glvnd/egl_vendor.d/50_mesa.json \
  -- timeout 200 xvfb-run -a -s '-extension GLX -screen 0 1280x900x24 -nolisten tcp' /node /driver.mjs "$3"
