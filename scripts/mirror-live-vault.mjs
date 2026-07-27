#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { MemoryAuthority } from "../packages/sync/dist/index.js";
import {
  DirectoryMirror,
  MirrorInitializationConflictError,
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
for (const [index, path] of paths.entries()) {
  const document = await sourceFiles.read(path);
  if (document === null) throw new Error(`Source document disappeared during scan: ${path}`);
  sourceBytes += Buffer.byteLength(document);
  records.push({
    record_id: createHash("sha256").update(path).digest("hex"),
    path,
    frontmatter: {
      type: "mirror-profile",
      title: `Live-vault profile ${index}`
    },
    body: document,
    types: ["mirror-profile"]
  });
}
const sourceScanMs = performance.now() - sourceStarted;

const hosted = new MemoryAuthority({ snapshotPageSize: 200 });
hosted.seed(records);
const writerId = hosted.registerReplica({
  name: "Live-vault adversary",
  mode: "read_write",
  allowedTypes: ["mirror-profile"]
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

  const divergencePath = paths[Math.floor(paths.length / 2)];
  const divergenceTarget = join(mirrorRoot, ...divergencePath.split("/"));
  const canonical = await readFile(divergenceTarget, "utf8");
  await writeFile(divergenceTarget, `${canonical}\nlocal adversarial edit\n`);
  await expectCode(() => mirror.sync(), "mirror_diverged");
  assert(
    (await readFile(divergenceTarget, "utf8")).endsWith("local adversarial edit\n"),
    "Receive-only mirror overwrote a divergent local file."
  );
  await writeFile(divergenceTarget, canonical);

  const writer = hosted.transport(writerId);
  const updateRecord = records[0];
  const renameRecord = records[1];
  const deleteRecord = records[2];
  const updated = await writer.mutate({
    mutation_id: randomUUID(),
    replica_id: writerId,
    scope_epoch: 1,
    operation: "update",
    record_id: updateRecord.record_id,
    base_revision: `hosted:0:${updateRecord.record_id}`,
    input: { patch: { live_vault_adversary: true } },
    created_at: new Date().toISOString()
  });
  assert(updated.status === "applied", "Adversarial remote update was not applied.");
  const renamedPath = `${renameRecord.path.replace(/\.md$/, "")}-renamed.md`;
  const renamed = await writer.mutate({
    mutation_id: randomUUID(),
    replica_id: writerId,
    scope_epoch: 1,
    operation: "rename",
    record_id: renameRecord.record_id,
    base_revision: `hosted:0:${renameRecord.record_id}`,
    input: { path: renamedPath },
    created_at: new Date().toISOString()
  });
  assert(renamed.status === "applied", "Adversarial remote rename was not applied.");
  const deleted = await writer.mutate({
    mutation_id: randomUUID(),
    replica_id: writerId,
    scope_epoch: 1,
    operation: "delete",
    record_id: deleteRecord.record_id,
    base_revision: `hosted:0:${deleteRecord.record_id}`,
    input: {},
    created_at: new Date().toISOString()
  });
  assert(deleted.status === "applied", "Adversarial remote delete was not applied.");
  const createdPath = "live-vault-adversarial-created.md";
  const created = await writer.mutate({
    mutation_id: randomUUID(),
    replica_id: writerId,
    scope_epoch: 1,
    operation: "create",
    record_id: randomUUID(),
    input: {
      path: createdPath,
      frontmatter: { type: "mirror-profile", title: "Adversarial create" },
      body: "Created during live-vault hardening.",
      types: ["mirror-profile"]
    },
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
  const collisionPath = paths.at(-1);
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
  try {
    await collisionMirror.sync();
    throw new Error("Late collision unexpectedly initialized.");
  } catch (error) {
    assert(error instanceof MirrorInitializationConflictError, "Late collision returned the wrong error.");
    assert(error.paths.includes(collisionPath), "Late collision did not identify its path.");
  }
  const collisionFiles = await new NodeMirrorFileSystem(collisionRoot).listMarkdown(new Set());
  assert(
    collisionFiles.length === 1 && collisionFiles[0] === collisionPath,
    "Collision preflight wrote files before discovering a late conflict."
  );

  process.stdout.write(`${JSON.stringify({
    live_vault_ok: true,
    source: sourceRoot,
    documents: paths.length,
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

async function expectCode(operation, code) {
  try {
    await operation();
  } catch (error) {
    assert(error && typeof error === "object" && error.code === code, `Expected ${code}.`);
    return;
  }
  throw new Error(`Expected ${code}.`);
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
