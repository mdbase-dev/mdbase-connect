// Existing service-local authenticated admin execution, never a public endpoint.
import { createHash, verify } from "node:crypto";
import { mkdir, lstat, open, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { DatabasePool } from "../../database-types.js";
import { audit } from "../../platform/audit-events.js";
import { inTransaction, lock, refuseRevoked } from "./bootstrap-common.js";
import { requireCollectionNotDeleted } from "./collection-deletion.js";
import { loadServiceDevice } from "./service-devices.js";
import { LogServiceClient } from "./log-service-client.js";
import { loadPolicySigner, verifyCert, ed25519PublicKeyObject, type NextControlPlaneConfig } from "./policy-keys.js";
import { decodeCbor, domainHash, encodeCbor, keyId, uuidBytes, type Cbor, type CpCert, type Decoded } from "./policy-wire.js";
import { captureLabNativeCut } from "./lab-native-backup.js";

interface AdminContext {
  db: DatabasePool; environment?: string; publicUrl?: string; runtimeRevision?: string;
  nextControlPlane?: () => NextControlPlaneConfig | null;
}
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const NIL = "00000000-0000-0000-0000-000000000000";
const sha = (raw: Uint8Array) => createHash("sha256").update(raw).digest();
const refuse = (): never => { throw new Error("lab_native_backup_refused"); };
function fixedFlags(argv: string[]): Map<string, string> {
  const allowed = ["collection", "operation-id", "expected-revision", "expected-source-origin", "actor", "reason"];
  if (argv.length !== allowed.length * 2) return refuse();
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]!.replace(/^--/, ""), value = argv[index + 1]!;
    if (argv[index] !== `--${name}` || !allowed.includes(name) || flags.has(name) || !value || value.length > 500) return refuse();
    flags.set(name, value);
  }
  return flags;
}
function canonicalOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) return refuse();
  return value;
}
function originalGenesis(raw: Uint8Array, collection: string, config: NextControlPlaneConfig): void {
  const value = decodeCbor(raw, {canonicalStructs: true, maxDepth: 32});
  const shape = (value: Decoded | undefined, keys: number[]): value is Map<number, Decoded> => value instanceof Map && value.size === keys.length && keys.every(key => value.has(key));
  const sized = (value: Decoded | undefined, size: number): value is Uint8Array => value instanceof Uint8Array && value.length === size;
  const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
  if (!shape(value, [0,1,2,3,4,6,11,12]) || value.get(0) !== 1 || value.get(1) !== 2 || value.get(3) !== 1
    || !sized(value.get(2), 16) || !same(value.get(2) as Uint8Array, uuidBytes(collection)) || !sized(value.get(4), 32)
    || (value.get(4) as Uint8Array).some(byte => byte !== 0) || !(value.get(11) instanceof Uint8Array) || !sized(value.get(12), 64)) return refuse();
  const payload = decodeCbor(value.get(11) as Uint8Array, {canonicalStructs: true, maxDepth: 32});
  if (!shape(payload, [0,1,2,3]) || payload.get(0) !== 1 || !Number.isSafeInteger(payload.get(2))) return refuse();
  const c = payload.get(1), ops = payload.get(3);
  if (!shape(c, [0,1,2,3,4]) || !sized(c.get(0), 32) || !sized(c.get(3), 16) || !sized(c.get(4), 64)
    || !Number.isSafeInteger(c.get(1)) || !Number.isSafeInteger(c.get(2)) || !Array.isArray(ops) || !ops.length) return refuse();
  const cert: CpCert = {policyPublicKey: c.get(0) as Uint8Array, notBefore: c.get(1) as number, notAfter: c.get(2) as number, root: c.get(3) as Uint8Array, signature: c.get(4) as Uint8Array};
  const created = payload.get(2) as number, genesis = ops[0];
  if (!verifyCert(cert, config.rootPublicKey) || created < cert.notBefore || created >= cert.notAfter || !sized(value.get(6), 16)
    || !same(value.get(6) as Uint8Array, keyId(cert.policyPublicKey)) || !shape(genesis, [0,1,2,3]) || genesis.get(0) !== 1
    || !sized(genesis.get(1), 16) || !sized(genesis.get(2), 16) || !same(genesis.get(2) as Uint8Array, keyId(config.rootPublicKey))
    || ![0, 1].includes(genesis.get(3) as number)) return refuse();
  // The original policy item uses only scalar/byte values at its outer level.
  const unsigned: Cbor = {struct: [...value.entries()].filter(([key]) => key !== 12).map(([key, field]) => [key, field as Cbor])};
  if (!verify(null, domainHash("mdbase/v1/item-sig", encodeCbor(unsigned)), ed25519PublicKeyObject(cert.policyPublicKey), value.get(12) as Uint8Array)) return refuse();
}
async function privateDirectory(path: string, allowExisting = false): Promise<void> {
  try {await mkdir(path, {mode: 0o700});} catch (error) {
    if (!allowExisting || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) return refuse();
}
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {await directory.sync();} finally {await directory.close();}
}
async function privateFile(path: string, bytes: Uint8Array): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {await file.writeFile(bytes); await file.sync();} finally {await file.close();}
}

export async function runLabNativeBackupAdmin(argv: string[], context: AdminContext): Promise<unknown> {
  // Admit LAB scope and exact command BEFORE parsing/loading any key or database.
  if (context.environment !== "lab" || context.publicUrl !== "https://connect-lab.mdbase.dev" || argv[0] !== "capture") return refuse();
  const flags = fixedFlags(argv.slice(1));
  const collection = flags.get("collection")!, operation = flags.get("operation-id")!, expected = flags.get("expected-revision")!;
  const actor = flags.get("actor")!, reason = flags.get("reason")!;
  if (![collection, operation].every(value => UUID.test(value) && value !== NIL) || !/^[0-9a-f]{40}$/.test(expected)
    || context.runtimeRevision !== expected || !actor.trim() || actor.length > 200 || !reason.trim()) return refuse();
  const source = canonicalOrigin(flags.get("expected-source-origin")!);
  const config = context.nextControlPlane?.();
  if (!config || canonicalOrigin(config.logService.url.replace(/\/$/, "")) !== source) return refuse();
  let device: string | undefined, genesis: Uint8Array | undefined;
  const denyFirst = () => inTransaction(context.db, async client => {
    await lock(client, collection);
    await requireCollectionNotDeleted(client, collection);
    const record = await loadServiceDevice(client, collection, {kind: "hosted"});
    if (!record || device && record.device_id !== device) return refuse();
    await refuseRevoked(client, collection, record.device_id);
    const rows = await client.query<{state: string; item: Buffer | null}>(
      "SELECT state, CASE WHEN octet_length(item) BETWEEN 1 AND 65536 THEN item ELSE NULL END AS item FROM next_policy_batches WHERE collection_id=$1 AND seq=1 ORDER BY id LIMIT 2 FOR SHARE", [collection]);
    const raw = rows.rows[0]?.item;
    if (rows.rows.length !== 1 || rows.rows[0]?.state !== "appended" || !raw || genesis && !Buffer.from(genesis).equals(raw)) return refuse();
    if (!genesis) originalGenesis(raw, collection, config);
    device = record.device_id; genesis = Buffer.from(raw);
  });
  const metadata = {operation_id: operation, actor, reason, collection, source_origin: source, runtime_revision: expected};
  try {
    await denyFirst();
    // Load signing/transport keys only after the fresh authoritative denial read.
    const signer = loadPolicySigner(config, Date.now());
    const log = new LogServiceClient(config.logService);
    // Never overwrite a prior operation, partial cut or uncertain receipt.
    const scratch = join(process.cwd(), "scratch");
    await privateDirectory(scratch, true);
    const root = join(scratch, "lab-native-backup");
    await privateDirectory(root, true);
    const stage = join(root, operation);
    await privateDirectory(stage);
    await privateFile(join(stage, "operation.json"), Buffer.from(JSON.stringify({...metadata, state: "started"})));
    await audit(context.db, null, "next.lab_native_backup_started", null, metadata);
    const cut = await captureLabNativeCut({collection, operationId: operation, sourceOrigin: source, runtimeRevision: expected, originalGenesis: genesis!, signer, log, denyFirst});
    const cutDir = join(stage, "cut");
    await privateDirectory(cutDir); await privateDirectory(join(cutDir, "pages")); await privateDirectory(join(cutDir, "objects"));
    await privateFile(join(cutDir, "header.cbor"), cut.header); await privateFile(join(cutDir, "finish.cbor"), cut.finish);
    for (let index = 0; index < cut.pages.length; index++) await privateFile(join(cutDir, "pages", `${String(index + 1).padStart(10, "0")}.cbor`), cut.pages[index]!);
    for (const object of cut.objects) await privateFile(join(cutDir, "objects", `${Buffer.from(object.address).toString("hex")}.cbor`), object.bytes);
    await privateFile(join(stage, "capture-context.cbor"), cut.captureContext);
    await privateFile(join(stage, ".completion.pending"), cut.completion);
    await syncDirectory(join(cutDir, "pages")); await syncDirectory(join(cutDir, "objects"));
    await syncDirectory(cutDir); await syncDirectory(stage); await syncDirectory(root);
    await audit(context.db, null, "next.lab_native_backup_closure_ready", null, metadata);
    await denyFirst();
    // Atomic, exclusive publication LAST; never expose a partial completion.
    await link(join(stage, ".completion.pending"), join(stage, "completion.cbor"));
    // Offline admission requires a single-link immutable completion file.
    // Any publication/durability failure remains CLOSED, even if bytes exist.
    await unlink(join(stage, ".completion.pending"));
    await syncDirectory(stage);
    return {schema: "mdbase-lab-native-backup/v1", ...metadata, stage: `scratch/lab-native-backup/${operation}`, native_only: true,
      page_count: cut.pages.length, object_count: cut.objects.length, completion_sha256: sha(cut.completion).toString("hex")};
  } catch {
    // UNKNOWN is terminal. No generic RPC retry/abort, raw DB/network diagnostic,
    // signing bytes, auxiliary tokens, object bytes or private keys in job output.
    throw new Error("lab_native_backup_failed_reconcile_required");
  }
}
