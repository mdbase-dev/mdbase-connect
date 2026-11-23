#!/usr/bin/env bash
# Linux, bubblewrap, Node 22+, locally installed @playwright/test, Chromium/Chrome.
# Native permission tests also use Xvfb, ImageMagick import, Tesseract (English), Python and libXtst.
# All input paths must be outside /tmp and /run, which are private inside the run.
# Substitute --entry-only for the CLI to check invitation handling before a backend exists.
# Run from the Connect worktree. By default only loopback exists. Prefix any command with
# --net-fixture to put Chrome and the daemon in separate namespaces linked only by RFC1918 veth.
# CHROME_BIN=/opt/google/chrome/chrome runtime/scripts/qualify-webtransport.sh platform
# runtime/scripts/qualify-webtransport.sh tasknotes <built-mdbase> <TaskNotes-worktree> <direct-dist> <https-ui-origin>
# runtime/scripts/qualify-webtransport.sh editor <built-mdbase> <direct-dist> <https-ui-origin>
# For live rollover, insert --rollover before the app name (after --net-fixture if used).
# Requires sqlite3 and an absolute WT_FAKETIME_LIB. In an external clean checkout
# of wolfcw/libfaketime v0.9.12, build its stateless library with monotonic waits
# left to libc (the distro build's pthread hooks can stall sandboxed Chrome):
# make -B -C src CFLAGS='-O2 -fPIC -std=gnu99 -D_GNU_SOURCE -include pthread.h -DFAKE_STATELESS -DFAKE_STAT -DFAKE_INTERNAL_CALLS' libfaketime.so.1
# export WT_FAKETIME_LIB="$PWD/src/libfaketime.so.1"
set -euo pipefail
script_dir=$(dirname "$(realpath "$0")")
node_bin=$(realpath "$(command -v node)")
fixture=()
if [[ ${1:-} == --net-fixture ]]; then
  shift
  fixture=(unshare --user --map-current-user --keep-caps --net "$script_dir/webtransport-net-fixture.sh")
fi
args=()
if [[ ${1:-} == --rollover ]]; then
  shift
  clock_lib=$(realpath -e "${WT_FAKETIME_LIB:?--rollover requires WT_FAKETIME_LIB}")
  args+=(--setenv WT_FAKETIME_LIB "$clock_lib")
fi
if [[ -n ${CHROME_BIN:-} ]]; then
  args+=(--setenv CHROME_BIN "$(realpath "$CHROME_BIN")")
else
  chrome=$(cd "$script_dir" && "$node_bin" -p "require('@playwright/test').chromium.executablePath()")
  args+=(--setenv CHROME_BIN "$chrome")
fi
exec bwrap --die-with-parent --unshare-net --unshare-pid --unshare-ipc \
  --ro-bind / / --dev /dev --proc /proc --tmpfs /dev/shm --tmpfs /run --tmpfs /tmp \
  --dir /tmp/.X11-unix --dir /tmp/qualification-home --clearenv --setenv HOME /tmp/qualification-home \
  --setenv PATH /usr/bin:/bin --setenv LANG C.UTF-8 --setenv LIBGL_ALWAYS_SOFTWARE 1 --setenv __EGL_VENDOR_LIBRARY_FILENAMES /usr/share/glvnd/egl_vendor.d/50_mesa.json "${args[@]}" \
  -- "${fixture[@]}" xvfb-run -a -s "-extension GLX -screen 0 1280x900x24 -nolisten tcp" "$node_bin" "$script_dir/qualify-webtransport.mjs" "$@"
