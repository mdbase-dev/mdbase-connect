// Composition boundary to the existing native verifier. Trust is supplied by the
// operator independently, never manufactured from the archive being verified.
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

export interface NativeBackupVerifier {
  executable: string;
  /** Existing owner-only directory, outside live service state. */
  stageRoot: string;
  /** Independently authenticated native backup-purpose trust.cbor. */
  trust: Uint8Array;
}
export type NativeArchiveFiles = ReadonlyMap<string, Uint8Array>;
export const nativeArchivePath = (name: string): boolean =>
  /^(?:cut\/(?:header|finish)\.cbor|cut\/pages\/[0-9]{10}\.cbor|cut\/objects\/[0-9a-f]{64}\.cbor|completion\.cbor|capture-context\.cbor)$/.test(name);

export async function verifyNativeArchive(files: NativeArchiveFiles, verifier: NativeBackupVerifier): Promise<void> {
  if (!isAbsolute(verifier.executable) || !isAbsolute(verifier.stageRoot) || !verifier.trust.length || verifier.trust.length > 65536
    || [...files.keys()].some(name => !nativeArchivePath(name))) throw new Error("native_backup_verifier_configuration");
  const stat = await lstat(verifier.stageRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("native_backup_private_stage_required");
  const stage = await mkdtemp(join(verifier.stageRoot, "native-backup-"));
  try {
    await mkdir(join(stage, "cut"), {mode: 0o700});
    await mkdir(join(stage, "cut/pages"), {mode: 0o700});
    await mkdir(join(stage, "cut/objects"), {mode: 0o700});
    for (const [name, bytes] of files) await writeFile(join(stage, name), bytes, {mode: 0o600, flag: "wx"});
    await writeFile(join(stage, "trust.cbor"), verifier.trust, {mode: 0o600, flag: "wx"});
    const {stdout, stderr} = await promisify(execFile)(verifier.executable, ["--cut-dir", join(stage, "cut"),
      "--completion", join(stage, "completion.cbor"), "--trust", join(stage, "trust.cbor")], {timeout: 300_000, maxBuffer: 4096});
    const result: unknown = JSON.parse(stdout);
    if (stderr || typeof result !== "object" || result === null || !("verified" in result) || result.verified !== true
      || !("current_authority_verified" in result) || result.current_authority_verified !== false) throw new Error("native_backup_verifier_refused");
  } catch {
    // No subprocess paths, tokens, payloads or arbitrary diagnostics escape.
    throw new Error("native_backup_verification_failed");
  } finally { await rm(stage, {recursive: true, force: true}); }
}
