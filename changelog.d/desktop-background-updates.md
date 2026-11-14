## Added

- On Linux, mdbase connect installed in a folder you own now updates itself and the mdbase daemon in the background every six hours, even when the app is not running (`systemctl --user status mdbase-connect-update`).
- `mdbase doctor` reports the release mdbase connect last found and how to install it, instead of saying automatic updates are unavailable.
- An install script for Linux sets up mdbase connect in `~/.local/opt/mdbase-connect` without root, verifying the release's checksum and, with `cosign`, its signature.
- On Linux desktops whose session type is not passed to the app, such as Hyprland started from a systemd user unit, mdbase connect now uses Wayland instead of falling back to X11.
