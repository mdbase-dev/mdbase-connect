#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { MemoryAuthority } from "../packages/sync/dist/index.js";
import { parseMarkdown } from "../packages/sync/dist/mirror-format.js";
import { portableMirrorPathKey } from "../packages/sync/dist/portable-path.js";
import {
  DirectoryMirror,
  NodeMirrorFileSystem,
  NodeMirrorLease,
  NodeMirrorStateStore,
  mirrorLeaseDirectory
} from "../packages/sync/dist/node.js";

const sourceArgument = process.argv.indexOf("--source");
const source = sourceArgument < 0
  ? process.env.MDBASE_CONNECT_PROFILE_VAULT
  : process.argv[sourceArgument + 1];
if (!source) {
  throw new Error("Pass --source <vault> or set MDBASE_CONNECT_PROFILE_VAULT.");
}
const sourceRoot = resolve(source);
const sourceFiles = new NodeMirrorFileSystem(sourceRoot);
const paths = await sourceFiles.listMarkdown(new Set());
if (paths.length === 0) throw new Error("The profiling vault contains no Markdown files.");

const sourceStarted = performance.now();
let sourceBytes = 0;
const records = [];
const portablePathOwners = new Map();
const rejectedPaths = [];
for (const path of paths) {
  const document = await sourceFiles.read(path);
  if (document === null) throw new Error(`Source document disappeared during scan: ${path}`);
  sourceBytes += Buffer.byteLength(document);
  let portableKey;
  try {
    portableKey = portableMirrorPathKey(path);
  } catch {
    rejectedPaths.push({ path, reason: "not_portable" });
    continue;
  }
  const owner = portablePathOwners.get(portableKey);
  if (owner) {
    rejectedPaths.push({ path, reason: "portable_alias", aliases: owner });
    continue;
  }
  portablePathOwners.set(portableKey, path);
  const projection = parseMarkdown(document, path);
  records.push({
    record_id: createHash("sha256").update(path).digest("hex"),
    path,
    document,
    frontmatter: projection.frontmatter,
    body: projection.body,
    types: []
  });
}
const hostedPaths = records.map((record) => record.path);
if (hostedPaths.length < 3) throw new Error("The profiling vault has fewer than three portable Markdown files.");
const sourceScanMs = performance.now() - sourceStarted;

const hosted = new MemoryAuthority({ snapshotPageSize: 200 });
hosted.seed(records);
const authoritativeRecords = hosted.serialize().records;
const writerId = hosted.registerReplica({
  name: "Live-vault adversary",
  mode: "read_write"
});
const mirrorId = hosted.registerReplica({
  name: "Live-vault mirror",
  mode: "read_only"
});
const scratch = await mkdtemp(join(tmpdir(), "mdbase-mirror-live-vault-"));
const leaseDirectories = [];

try {
  const mirrorRoot = join(scratch, "mirror");
  const stateRoot = join(scratch, "state");
  await mkdir(mirrorRoot);
  leaseDirectories.push(await mirrorLeaseDirectory(mirrorRoot));
  const mirror = new DirectoryMirror(mirrorRoot, mirrorId, hosted.transport(mirrorId), {
    stateStore: new NodeMirrorStateStore(mirrorRoot, stateRoot),
    lease: new NodeMirrorLease(mirrorRoot)
  });

  const initialStarted = performance.now();
  await mirror.sync();
  const initialMs = performance.now() - initialStarted;
  const noOpStarted = performance.now();
  await mirror.sync();
  const noOpMs = performance.now() - noOpStarted;

  const divergencePath = hostedPaths[Math.floor(hostedPaths.length / 2)];
  const divergenceTarget = join(mirrorRoot, ...divergencePath.split("/"));
  const canonical = await readFile(divergenceTarget, "utf8");
  await writeFile(divergenceTarget, `${canonical}\nlocal adversarial edit\n`);
  const divergence = await mirror.sync();
  assert(
    divergence.status === "attention"
      && divergence.issues.some((issue) => issue.code === "mirror_diverged" && issue.blocking),
    `Receive-only divergence was not returned as a blocking plan issue: ${JSON.stringify(divergence)}`
  );
  assert(
    (await readFile(divergenceTarget, "utf8")).endsWith("local adversarial edit\n"),
    "Receive-only mirror overwrote a divergent local file."
  );
  await writeFile(divergenceTarget, canonical);

  const writer = hosted.transport(writerId);
  const updateRecord = authoritativeRecords[0];
  const renameRecord = authoritativeRecords[1];
  const deleteRecord = authoritativeRecords[2];
  const updated = await writer.mutate({
    mutation_id: randomUUID(),
    replica_id: writerId,
    scope_epoch: 1,
    operation: "put",
    record_id: updateRecord.record_id,
    base_revision: updateRecord.revision,
    path: updateRecord.path,
    document: `${updateRecord.document}\nlive_vault_adversary: true\n`,
    created_at: new Date().toISOString()
  });
  assert(updated.status === "applied", "Adversarial remote update was not applied.");
  const renamedPath = `${renameRecord.path.replace(/\.md$/, "")}-renamed.md`;
  const renamed = await writer.mutate({
    mutation_id: randomUUID(),
    replica_id: writerId,
    scope_epoch: 1,
    operation: "move",
    record_id: renameRecord.record_id,
    base_revision: renameRecord.revision,
    path: renamedPath,
    created_at: new Date().toISOString()
  });
  assert(renamed.status === "applied", "Adversarial remote rename was not applied.");
  const deleted = await writer.mutate({
    mutation_id: randomUUID(),
    replica_id: writerId,
    scope_epoch: 1,
    operation: "delete",
    record_id: deleteRecord.record_id,
    base_revision: deleteRecord.revision,
    created_at: new Date().toISOString()
  });
  assert(deleted.status === "applied", "Adversarial remote delete was not applied.");
  const createdPath = "live-vault-adversarial-created.md";
  const created = await writer.mutate({
    mutation_id: randomUUID(),
    replica_id: writerId,
    scope_epoch: 1,
    operation: "put",
    record_id: randomUUID(),
    path: createdPath,
    document: "---\ntype: mirror-profile\ntitle: Adversarial create\n---\nCreated during live-vault hardening.",
    created_at: new Date().toISOString()
  });
  assert(created.status === "applied", "Adversarial remote create was not applied.");

  const incrementalStarted = performance.now();
  await mirror.sync();
  const incrementalMs = performance.now() - incrementalStarted;
  await readFile(join(mirrorRoot, ...renamedPath.split("/")), "utf8");
  await readFile(join(mirrorRoot, createdPath), "utf8");
  await expectMissing(join(mirrorRoot, ...renameRecord.path.split("/")));
  await expectMissing(join(mirrorRoot, ...deleteRecord.path.split("/")));

  const collisionRoot = join(scratch, "collision");
  const collisionState = join(scratch, "collision-state");
  await mkdir(collisionRoot);
  leaseDirectories.push(await mirrorLeaseDirectory(collisionRoot));
  const collisionPath = hostedPaths.at(-1);
  const collisionTarget = join(collisionRoot, ...collisionPath.split("/"));
  await mkdir(dirname(collisionTarget), { recursive: true });
  await writeFile(collisionTarget, "unmanaged collision\n");
  const collisionReplica = hosted.registerReplica({
    name: "Late-collision mirror",
    mode: "read_only"
  });
  const collisionMirror = new DirectoryMirror(
    collisionRoot,
    collisionReplica,
    hosted.transport(collisionReplica),
    {
      stateStore: new NodeMirrorStateStore(collisionRoot, collisionState),
      lease: new NodeMirrorLease(collisionRoot)
    }
  );
  const collision = await collisionMirror.sync();
  assert(
    collision.status === "attention"
      && collision.issues.some((issue) => (
        issue.code === "local_collision"
          && issue.path === collisionPath
          && issue.blocking
      )),
    `Late collision was not returned as a blocking plan issue: ${JSON.stringify(collision)}`
  );
  const collisionFiles = await new NodeMirrorFileSystem(collisionRoot).listMarkdown(new Set());
  assert(
    collisionFiles.length === 1 && collisionFiles[0] === collisionPath,
    "Collision preflight wrote files before discovering a late conflict."
  );

  process.stdout.write(`${JSON.stringify({
    live_vault_ok: true,
    source: sourceRoot,
    documents: paths.length,
    hosted_documents: hostedPaths.length,
    rejected_paths: rejectedPaths,
    markdown_bytes: sourceBytes,
    source_scan_ms: Number(sourceScanMs.toFixed(3)),
    initial_sync_ms: Number(initialMs.toFixed(3)),
    no_op_sync_ms: Number(noOpMs.toFixed(3)),
    four_change_sync_ms: Number(incrementalMs.toFixed(3)),
    adversarial_checks: [
      "local divergence preserved",
      "remote update",
      "remote rename",
      "remote delete",
      "remote create",
      "late collision caused zero partial writes"
    ]
  }, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
  for (const directory of leaseDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectMissing(path) {
  try {
    await readFile(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Expected ${path} to be absent.`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
