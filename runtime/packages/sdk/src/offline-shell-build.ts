/** Node-only build adapter for the shared public app-shell service worker. */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { OfflineShellManifest } from "./offline-shell-worker.js";

export interface OfflineShellBuildOptions {
  directory: string;
  base?: string;
  /** Existing notification worker to extend instead of registering a second worker. */
  workerFile?: string;
  /** Existing apps may already register their notification worker. */
  register?: boolean;
}
/** Vite/Rollup build hook; never registers a worker on the development server. */
export function offlineShellPlugin(options: Omit<OfflineShellBuildOptions, "directory" | "base"> = {}) {
  let directory: string;
  let base: string;
  return {
    name: "mdbase-offline-shell",
    apply: "build" as const,
    configResolved(config: { root: string; base: string; build: { outDir: string } }): void {
      directory = resolve(config.root, config.build.outDir);
      base = config.base;
    },
    async closeBundle(): Promise<void> {
      await buildOfflineShell({ ...options, directory, base });
    },
  };
}
const marker = "\n// mdbase shared offline shell\n";
const registrationFile = "mdbase-shell-register.js";
const runtimeFile = "mdbase-shell-runtime.js";
const hash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Run after static routes/assets are generated, before publishing the directory.
 * Only shipped public files enter the cache, never runtime-fetched user data. */
export async function buildOfflineShell(options: OfflineShellBuildOptions): Promise<OfflineShellManifest> {
  const directory = resolve(options.directory);
  const base = options.base ?? "/";
  const workerFile = options.workerFile ?? "mdbase-shell-sw.js";
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base) || !/^[a-zA-Z0-9_-]+\.js$/.test(workerFile)) {
    throw new Error("Offline shell needs an absolute app base and a root worker filename");
  }
  const runtime = await readFile(new URL("./offline-shell-worker.js", import.meta.url), "utf8");
  await writeFile(join(directory, runtimeFile), runtime.replace(/\n\/\/# sourceMappingURL=.*$/m, ""));
  if (options.register !== false) {
    await writeFile(join(directory, registrationFile), `if ("serviceWorker" in navigator) navigator.serviceWorker.register(${JSON.stringify(base + workerFile)}, {scope:${JSON.stringify(base)},type:"module"}).catch(() => console.warn("Offline app support could not start."));\n`);
  }
  const paths: string[] = [];
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(join(directory, path), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      const relative = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(relative);
      else if (entry.isFile() && relative !== workerFile && /\.(?:html|js|mjs|css|wasm|woff2?|ttf|svg|png|webp|jpg|jpeg|ico|json|webmanifest)$/.test(relative)) paths.push(relative);
    }
  }
  await walk("");
  paths.sort();
  if (!paths.includes("index.html")) throw new Error("Offline shell needs index.html");
  const assets: OfflineShellManifest["assets"] = [];
  for (const path of paths) {
    if (path.endsWith(".html") && options.register !== false) {
      const file = join(directory, path);
      let html = await readFile(file, "utf8");
      const tag = `<script type="module" src="${base}${registrationFile}"></script>`;
      if (!html.includes(tag)) {
        if (!html.includes("</head>")) throw new Error("Offline shell HTML needs a head element");
        html = html.replace("</head>", `${tag}\n</head>`);
        await writeFile(file, html);
      }
    }
    assets.push({ path, sha256: hash(await readFile(join(directory, path))) });
  }
  let existing = options.workerFile ? await readFile(join(directory, workerFile), "utf8") : "";
  existing = existing.split(marker)[0]!;
  // Include worker code as well: notification-only changes still rotate the release cache.
  const version = hash(JSON.stringify({ base, assets, existing }));
  const manifest = { base, version, assets };
  await writeFile(join(directory, workerFile), `${existing}${marker}import {installOfflineShell} from "./${runtimeFile}";\ninstallOfflineShell(self, ${JSON.stringify(manifest)});\n`);
  return manifest;
}
