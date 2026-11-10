import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * Opens an mdbase app in a window of its own: the user's default browser in app
 * mode when that browser is Chromium-based, otherwise an ordinary tab. App mode
 * keeps the browser's own profile, so sign-in, passkeys and password managers work.
 */

export interface DefaultBrowser {
  /** A display name or desktop-entry ID, used to recognise the browser. */
  name: string;
  /** The executable (Windows, Linux) or `.app` bundle (macOS). */
  path: string;
  /** Arguments that must come before ours, such as `flatpak run <id>`. */
  args?: string[];
}

interface LaunchCommand {
  command: string;
  args: string[];
}

/** Credential-free HTTPS only; loopback HTTP is accepted for development builds. */
export function launchUrl(value: unknown, allowLoopback: boolean): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error("Invalid app address.");
  }
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(allowLoopback && loopback)) || url.username || url.password) {
    throw new Error("Apps open only from a credential-free HTTPS address.");
  }
  return url.href;
}

const chromium = /chrom(e|ium)|msedge|microsoft[- ]edge|brave|vivaldi/iu;

/** The app-mode command for a Chromium-based default browser, or null. */
export function appModeCommand(browser: DefaultBrowser, platform: NodeJS.Platform, url: string): LaunchCommand | null {
  if (!chromium.test(browser.name) && !chromium.test(basename(browser.path))) return null;
  const command = platform === "darwin" && browser.path.endsWith(".app")
    ? join(browser.path, "Contents", "MacOS", basename(browser.path, ".app"))
    : browser.path;
  return { command, args: [...browser.args ?? [], `--app=${url}`] };
}

/** `Exec=` of a desktop entry, without field codes or Flatpak's file-forwarding markers. */
export function desktopEntryCommand(entry: string): { path: string; args: string[] } | null {
  let inEntry = false;
  for (const line of entry.split(/\r?\n/u)) {
    if (line.startsWith("[")) inEntry = line.trim() === "[Desktop Entry]";
    else if (inEntry && line.startsWith("Exec=")) {
      const words = (line.slice(5).match(/"[^"]*"|\S+/gu) ?? [])
        .map((word) => word.replace(/^"(.*)"$/u, "$1"))
        .filter((word) => !/^%[a-zA-Z]$/u.test(word) && word !== "@@u" && word !== "@@");
      return words[0] ? { path: words[0], args: words.slice(1) } : null;
    }
  }
  return null;
}

function linuxApplicationDirs(env: NodeJS.ProcessEnv): string[] {
  const dataHome = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const dataDirs = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean);
  return [dataHome, join(dataHome, "flatpak", "exports", "share"), "/var/lib/flatpak/exports/share", ...dataDirs]
    .map((dir) => join(dir, "applications"));
}

/** The default browser on Linux, from `xdg-settings` and its desktop entry. */
export async function linuxDefaultBrowser(env: NodeJS.ProcessEnv = process.env): Promise<DefaultBrowser | null> {
  const id = await new Promise<string>((resolve) => {
    const child = spawn("xdg-settings", ["get", "default-web-browser"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out.trim()));
  });
  if (!id.endsWith(".desktop")) return null;
  for (const dir of linuxApplicationDirs(env)) {
    const file = join(dir, id);
    if (!existsSync(file)) continue;
    const exec = desktopEntryCommand(await readFile(file, "utf8"));
    return exec ? { name: id, ...exec } : null;
  }
  return null;
}

/** Starts the browser and resolves once it is running; never waits for it to exit. */
export function startDetached({ command, args }: LaunchCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function openApp(url: string, deps: {
  platform: NodeJS.Platform;
  defaultBrowser(): Promise<DefaultBrowser | null>;
  start(command: LaunchCommand): Promise<void>;
  openExternal(url: string): Promise<void>;
}): Promise<void> {
  const browser = await deps.defaultBrowser().catch(() => null);
  const command = browser && appModeCommand(browser, deps.platform, url);
  if (command) {
    try {
      await deps.start(command);
      return;
    } catch (error) {
      console.warn("Could not open the app in its own window; opening it in the browser.", error);
    }
  }
  await deps.openExternal(url);
}
