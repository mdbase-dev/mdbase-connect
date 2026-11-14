/**
 * Which display platform Chromium starts on Linux.
 *
 * Chromium picks X11 or Wayland before the app's code can change it: only the
 * `--ozone-platform` switch on the command line and `XDG_SESSION_TYPE=wayland`
 * count (`app.commandLine.appendSwitch`, `--ozone-platform-hint=auto` and
 * `ELECTRON_OZONE_PLATFORM_HINT` are all too late or ignored in Electron 43).
 * systemd user services, the login-autostart units systemd generates and the
 * daemon's confirmation dialog inherit a user manager that often has
 * `WAYLAND_DISPLAY` but no `XDG_SESSION_TYPE`, so Chromium falls back to X11, and
 * where X11 is unavailable the app exits before showing anything.
 *
 * `entry.ts` runs before Chromium chooses, so when this returns arguments it
 * replaces the process with the same app and the switch added (same PID, same
 * service). The background update (`--mdbase-update`) needs no display at all.
 */

/** Starts the background update instead of the app (`headless-update.ts`). */
export const UPDATE_SWITCH = "--mdbase-update";

export function platformArguments(
  platform: NodeJS.Platform,
  argv: readonly string[],
  env: NodeJS.ProcessEnv
): string[] | null {
  if (platform !== "linux") return null;
  if (argv.some((value) => value === "--ozone-platform" || value.startsWith("--ozone-platform="))) return null;
  const session = env.XDG_SESSION_TYPE;
  const wanted = argv.includes(UPDATE_SWITCH)
    ? "headless"
    : session !== "wayland" && session !== "x11" && env.WAYLAND_DISPLAY
      ? "wayland"
      : null;
  if (!wanted) return null;
  return [argv[0]!, `--ozone-platform=${wanted}`, ...argv.slice(1)];
}
