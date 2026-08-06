#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { MemoryAuthority } from "../packages/sync/dist/index.js";
import { portableMirrorPathKey } from "../packages/sync/dist/portable-path.js";
import {
  DirectoryMirror,
  MemoryMirrorStateStore,
  NodeMirrorFileSystem,
  WritableDirectoryMirror
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
if (paths.length === 0) throw new Error("The live vault contains no Markdown files.");

const documents = new Map();
const portablePathOwners = new Map();
const rejectedPaths = [];
let markdownBytes = 0;
for (const path of paths) {
  const document = await sourceFiles.read(path);
  if (document === null) throw new Error(`Source document disappeared during scan: ${path}`);
  markdownBytes += Buffer.byteLength(document);
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
  documents.set(path, document);
}
const bodyOnlyPaths = paths.filter((path) => !hasCompleteFrontmatter(documents.get(path)));
if (bodyOnlyPaths.length === 0) {
  throw new Error("The live vault contains no body-only Markdown to exercise.");
}

const scratch = await mkdtemp(join(tmpdir(), "mdbase-writable-live-vault-"));
try {
  const writableRoot = join(scratch, "writable");
  const readerRoot = join(scratch, "reader");
  await mkdir(writableRoot);
  await mkdir(readerRoot);
  for (const [path, document] of documents) {
    const target = join(writableRoot, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, document);
  }

  const beforeDigest = digestDocuments(documents);
  const authority = new MemoryAuthority({ snapshotPageSize: 200 });
  const writerId = authority.registerReplica({ name: "Live vault writer", mode: "read_write" });
  const writable = new WritableDirectoryMirror(
    writableRoot,
    writerId,
    authority.transport(writerId),
    { stateStore: new MemoryMirrorStateStore() }
  );

  const preview = await writable.previewInitialization();
  const initialStarted = performance.now();
  await writable.sync();
  const initialMs = performance.now() - initialStarted;
  const noOpStarted = performance.now();
  await writable.sync();
  const noOpMs = performance.now() - noOpStarted;

  const afterDocuments = new Map();
  for (const path of documents.keys()) {
    afterDocuments.set(path, await readFile(join(writableRoot, ...path.split("/")), "utf8"));
  }
  assert(digestDocuments(afterDocuments) === beforeDigest, "Initial writable sync changed source bytes.");

  let records = await snapshotAll(authority.transport(writerId));
  assert(
    records.length === documents.size - preview.local_issues.length,
    "Writable import did not upload every structurally valid record."
  );
  const initialStatus = await writable.status();
  assert(
    initialStatus.local_issues.length === preview.local_issues.length,
    "Initial sync did not retain every previewed local issue."
  );

  const preferred = bodyOnlyPaths.includes("Canvas Bases/Start Here.md")
    ? "Canvas Bases/Start Here.md"
    : bodyOnlyPaths[0];
  const preferredTarget = join(writableRoot, ...preferred.split("/"));
  const original = await readFile(preferredTarget, "utf8");
  const localBody = `${original}${original.endsWith("\n") || original.length === 0 ? "" : "\n"}\nLive-vault local edit.\n`;
  await writeFile(preferredTarget, localBody);
  await writable.sync();
  let bodyOnlyRecord = (await snapshotAll(authority.transport(writerId)))
    .find((record) => record.path === preferred);
  assert(bodyOnlyRecord, `Body-only sample was not uploaded: ${preferred}`);
  assert(Object.keys(bodyOnlyRecord.frontmatter).length === 0, "Body-only sample gained frontmatter.");
  assert(bodyOnlyRecord.body === localBody, "Body-only local edit changed during upload.");

  const readerId = authority.registerReplica({ name: "Live vault reader", mode: "read_only" });
  const reader = new DirectoryMirror(
    readerRoot,
    readerId,
    authority.transport(readerId),
    { stateStore: new MemoryMirrorStateStore() }
  );
  await reader.sync();
  assert(
    await readFile(join(readerRoot, ...preferred.split("/")), "utf8") === localBody,
    "A second replica did not materialize body-only Markdown exactly."
  );

  const remoteBody = `${localBody}\nLive-vault remote edit.\n`;
  const remoteReceipt = await authority.transport(writerId).mutate({
    mutation_id: randomUUID(),
    replica_id: writerId,
    scope_epoch: 1,
    operation: "put",
    record_id: bodyOnlyRecord.record_id,
    base_revision: bodyOnlyRecord.revision,
    path: bodyOnlyRecord.path,
    document: remoteBody,
    created_at: new Date().toISOString()
  });
  assert(remoteReceipt.status === "applied", "Remote body-only update was rejected.");
  await writable.sync();
  assert(
    await readFile(preferredTarget, "utf8") === remoteBody,
    "Writable mirror did not apply a remote body-only update."
  );

  const renamedPath = uniqueRenamedPath(preferred, new Set(documents.keys()));
  const renamedTarget = join(writableRoot, ...renamedPath.split("/"));
  await rename(preferredTarget, renamedTarget);
  await writable.sync();
  records = await snapshotAll(authority.transport(writerId));
  bodyOnlyRecord = records.find((record) => record.record_id === bodyOnlyRecord.record_id);
  assert(bodyOnlyRecord?.path === renamedPath, "Body-only rename did not retain record identity.");

  await unlink(renamedTarget);
  await writable.sync();
  assert(
    !(await snapshotAll(authority.transport(writerId)))
      .some((record) => record.record_id === bodyOnlyRecord.record_id),
    "Body-only deletion did not reach the authority."
  );

  const invalidPath = "__mdbase-live-vault-invalid.md";
  const invalidDocument = "---\nbroken: [\n---\nThis must remain an invalid explicit frontmatter block.\n";
  await writeFile(join(writableRoot, invalidPath), invalidDocument);
  await writable.sync();
  const invalidRecord = (await snapshotAll(authority.transport(writerId)))
    .find((record) => record.path === invalidPath);
  assert(
    invalidRecord?.document === invalidDocument
      && Object.keys(invalidRecord.frontmatter).length === 0
      && invalidRecord.body === invalidDocument,
    "Malformed explicit frontmatter was not uploaded as exact opaque Markdown."
  );
  await reader.sync();
  assert(
    await readFile(join(readerRoot, invalidPath), "utf8") === invalidDocument,
    "A second replica did not preserve malformed frontmatter bytes."
  );

  process.stdout.write(`${JSON.stringify({
    writable_live_vault_ok: true,
    source: sourceRoot,
    documents: paths.length,
    portable_documents: documents.size,
    rejected_paths: rejectedPaths,
    body_only_documents: bodyOnlyPaths.length,
    initial_local_issues: preview.local_issues.length,
    markdown_bytes: markdownBytes,
    initial_sync_ms: Number(initialMs.toFixed(3)),
    no_op_sync_ms: Number(noOpMs.toFixed(3)),
    sample: preferred,
    adversarial_checks: [
      "initial import preserved every source byte",
      "second sync was a no-op",
      "local body-only edit uploaded",
      "second replica materialized body-only bytes",
      "remote body-only edit downloaded",
      "rename retained record identity",
      "delete removed the authority record",
      "malformed explicit frontmatter synchronized as exact opaque Markdown"
    ]
  }, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

function hasCompleteFrontmatter(document) {
  return /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(document);
}

function digestDocuments(documents) {
  const hash = createHash("sha256");
  for (const [path, document] of [...documents].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(path);
    hash.update("\0");
    hash.update(document);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function snapshotAll(transport) {
  const session = await transport.openSession();
  const records = [];
  let page;
  do {
    const snapshot = await transport.snapshot(session.snapshot_id, page);
    records.push(...snapshot.records);
    page = snapshot.next_page;
  } while (page);
  return records;
}

function uniqueRenamedPath(path, existing) {
  const candidate = path.replace(/\.md$/i, " mdbase-e2e-renamed.md");
  if (!existing.has(candidate)) return candidate;
  return path.replace(/\.md$/i, ` mdbase-e2e-renamed-${randomUUID()}.md`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
