import { spawn } from "node:child_process";
import { accessSync, constants, createReadStream, statSync } from "node:fs";
import { access, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";

/**
 * Replacing an app the user unpacked into a folder they own (for example
 * `~/.local/opt/mdbase-connect`) with the verified `.deb` of a newer release.
 * A package-manager install is owned by root, so it never qualifies and keeps
 * opening the release page: Electron never writes to `/usr` or asks for privilege.
 */

const PACKAGED_APP = "usr/lib/mdbase-connect";

/** The app folder, when the user owns it and can replace it; otherwise null. */
export function userOwnedAppDirectory(executablePath: string, uid: number): string | null {
  const directory = dirname(executablePath);
  try {
    if (statSync(directory).uid !== uid) return null;
    accessSync(directory, constants.W_OK);
    accessSync(dirname(directory), constants.W_OK);
    return directory;
  } catch {
    return null;
  }
}

// A verified release waits next to the app, so the swap is two renames on one
// filesystem; the replaced app stays as `.previous` for a manual rollback.
const staged = (appDirectory: string) => `${appDirectory}.next`;
const previous = (appDirectory: string) => `${appDirectory}.previous`;

/** Unpacks the app folder of a verified `.deb` to the staged directory. */
export async function stageDebApp(deb: string, appDirectory: string, signal: AbortSignal): Promise<void> {
  const unpacked = `${appDirectory}.unpacking`;
  await rm(staged(appDirectory), { recursive: true, force: true });
  try {
    await extractDebData(deb, unpacked, signal);
    const app = join(unpacked, PACKAGED_APP);
    await access(join(app, "mdbase-connect"), constants.X_OK).catch(() => {
      throw new Error("The Linux package does not contain the mdbase connect app.");
    });
    await rename(app, staged(appDirectory));
  } finally {
    await rm(unpacked, { recursive: true, force: true });
  }
}

/** Moves the running app aside and the staged one into its place. */
export async function swapStagedApp(appDirectory: string): Promise<void> {
  await access(staged(appDirectory));
  await rm(previous(appDirectory), { recursive: true, force: true });
  await rename(appDirectory, previous(appDirectory));
  try {
    await rename(staged(appDirectory), appDirectory);
  } catch (error) {
    await rename(previous(appDirectory), appDirectory);
    throw error;
  }
}

/** Streams the `.deb`'s `data.tar.zst` member through zstd into `tar`. */
async function extractDebData(deb: string, destination: string, signal: AbortSignal): Promise<void> {
  const member = await findArMember(deb, "data.tar.zst");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const tar = spawn("tar", ["-x", "-f", "-", "-C", destination, "--no-same-owner"], {
    stdio: ["pipe", "ignore", "pipe"],
    signal
  });
  let stderr = "";
  tar.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
  const exited = new Promise<number | null>((resolve, reject) => {
    tar.once("error", reject);
    tar.once("close", resolve);
  });
  try {
    await pipeline(
      createReadStream(deb, { start: member.start, end: member.start + member.size - 1 }),
      createZstdDecompress(),
      tar.stdin,
      { signal }
    );
  } catch (error) {
    // tar exits once it has read the end of the archive, which can be before
    // its input finishes closing; its exit code below then decides.
    const inputClosed = !signal.aborted && ["ERR_STREAM_PREMATURE_CLOSE", "EPIPE"].includes((error as NodeJS.ErrnoException).code ?? "");
    if (!inputClosed) {
      tar.kill();
      await exited.catch(() => undefined);
      throw error;
    }
  }
  const code = await exited;
  if (code !== 0) throw new Error(`The Linux package could not be unpacked: ${stderr.trim() || `tar exited with ${code}`}.`);
}

/** The byte range of a member in a Unix `ar` archive (the `.deb` container). */
async function findArMember(path: string, name: string): Promise<{ start: number; size: number }> {
  const file = await open(path, "r");
  try {
    const { size: total } = await file.stat();
    const magic = Buffer.alloc(8);
    await file.read(magic, 0, 8, 0);
    if (magic.toString("latin1") !== "!<arch>\n") throw new Error("The Linux package is not a Debian archive.");
    const header = Buffer.alloc(60);
    let offset = 8;
    while (offset + 60 <= total) {
      await file.read(header, 0, 60, offset);
      if (header.toString("latin1", 58, 60) !== "`\n") throw new Error("The Linux package is malformed.");
      const memberName = header.toString("latin1", 0, 16).trim().replace(/\/$/, "");
      const size = Number(header.toString("latin1", 48, 58).trim());
      if (!Number.isSafeInteger(size) || size < 0 || offset + 60 + size > total) {
        throw new Error("The Linux package is malformed.");
      }
      if (memberName === name) return { start: offset + 60, size };
      offset += 60 + size + (size % 2);
    }
    throw new Error(`The Linux package has no ${name}.`);
  } finally {
    await file.close();
  }
}
