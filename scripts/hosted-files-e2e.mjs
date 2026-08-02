import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { MdbaseFileClient } from "../packages/client/dist/files.js";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const providerBinary = join(root, "target/debug/mdbase-connect-hosted-provider");
const suffix = process.pid;
const postgres = `mdbase-files-postgres-${suffix}`;
const objects = `mdbase-files-objects-${suffix}`;
const password = `postgres-${randomUUID()}`;
const internalToken = `internal-${randomUUID()}-${randomUUID()}`;
const masterKey = randomBytes(32).toString("base64url");
const objectAccess = "mdbase-test-access";
const objectSecret = "mdbase-test-secret-key";
const bucket = "mdbase-connect-files";
let provider;

try {
  const databaseUrl = await startPostgres();
  const endpoint = await startObjects();
  provider = await startProvider(databaseUrl, endpoint);
  assert.equal((await request(provider.url, "/ready")).status, 200);

  const collectionId = randomUUID();
  const accountId = randomUUID();
  await ok(request(provider.url, `/internal/v1/accounts/${accountId}`, {
    method: "PUT",
    token: internalToken,
    body: {
      entitlement_revision: 1,
      hosted_storage_bytes: 1024 * 1024 * 1024,
      retained_file_bytes: 2 * 1024 * 1024 * 1024,
      max_document_bytes: 2 * 1024 * 1024,
      max_single_file_bytes: 250 * 1024 * 1024,
      max_replicas_per_collection: 10,
      max_hosted_collections: 10,
      max_files_per_collection: 10_000
    }
  }));
  await internal(provider.url, "/internal/v1/collections", {
    account_id: accountId,
    collection_id: collectionId,
    template: "mdbase",
    display_name: "Hosted files"
  });
  const writer = { id: randomUUID(), token: `writer-${randomUUID()}-${randomUUID()}` };
  await internal(provider.url, `/internal/v1/collections/${collectionId}/replicas`, {
    replica_id: writer.id,
    name: "File writer",
    purpose: "mirror",
    mode: "read_write",
    allowed_types: [],
    contract_scope: [],
    full_collection: false,
    allowed_operations: [],
    token: writer.token
  });

  const small = Buffer.from("hosted file bytes\0with binary\xff", "latin1");
  const smallUpload = await upload(provider.url, collectionId, writer.token, "Assets/small.bin", small);
  assert.equal(smallUpload.open.strategy.kind, "object_put");
  assert.deepEqual(smallUpload.receipt.file.content_digest, digest(small));
  const replay = await json(provider.url,
    `/v1/authorities/${collectionId}/files/uploads/${smallUpload.transferId}/commit`, writer.token,
    { protocol_version: 1, type: "commit_file_upload", transfer_id: smallUpload.transferId, parts: [] });
  assert.deepEqual(replay.file, smallUpload.receipt.file);

  const large = Buffer.alloc(8 * 1024 * 1024 + 17, 0x5a);
  large.fill(Buffer.from("tail"), large.length - 4);
  const largeUpload = await upload(provider.url, collectionId, writer.token, "Media/large.bin", large);
  assert.equal(largeUpload.open.strategy.kind, "object_multipart");

  const sdk = fileSdk(provider.url, collectionId, writer.token);
  const sdkBytes = Buffer.from("uploaded and verified through the public SDK");
  const sdkFile = await sdk.upload("Assets/sdk.bin", sdkBytes);
  assert.equal(sdkFile.content_digest, digest(sdkBytes));
  assert.deepEqual(Buffer.from(await sdk.downloadBytes(sdkFile)), sdkBytes);

  const sdkObjectKey = await pg(`SELECT object_key FROM hosted_provider_files WHERE file_id = '${sdkFile.file_id}'`);
  const moveMutationId = randomUUID();
  const [moved, concurrentReplay] = await Promise.all([
    sdk.move(sdkFile, "Archive/sdk-renamed.bin", { mutationId: moveMutationId }),
    sdk.move(sdkFile, "Archive/sdk-renamed.bin", { mutationId: moveMutationId })
  ]);
  assert.deepEqual(concurrentReplay, moved);
  assert.equal(moved.file_id, sdkFile.file_id);
  assert.notEqual(moved.revision, sdkFile.revision);
  assert.deepEqual(await sdk.move(sdkFile, moved.path, { mutationId: moveMutationId }), moved);
  assert.equal(await pg(`SELECT object_key FROM hosted_provider_files WHERE file_id = '${sdkFile.file_id}'`), sdkObjectKey);
  assert.deepEqual(Buffer.from(await sdk.downloadBytes(moved)), sdkBytes);

  const conflict = await request(provider.url,
    `/v1/authorities/${collectionId}/files/${sdkFile.file_id}/move`, {
      method: "POST", token: writer.token,
      body: { protocol_version: 1, type: "move_file", mutation_id: moveMutationId,
        file_id: sdkFile.file_id, if_revision: sdkFile.revision, from_path: sdkFile.path,
        path: "Archive/different.bin", update_references: false }
    });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "file_mutation_conflict");
  const stale = await request(provider.url,
    `/v1/authorities/${collectionId}/files/${moved.file_id}/move`, {
      method: "POST", token: writer.token,
      body: { protocol_version: 1, type: "move_file", mutation_id: randomUUID(),
        file_id: moved.file_id, if_revision: sdkFile.revision, from_path: moved.path,
        path: "Archive/stale.bin", update_references: false }
    });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "stale_file_revision");
  const hiddenMove = await request(provider.url,
    `/v1/authorities/${collectionId}/files/${moved.file_id}/move`, {
      method: "POST", token: writer.token,
      body: { protocol_version: 1, type: "move_file", mutation_id: randomUUID(),
        file_id: moved.file_id, if_revision: moved.revision, from_path: moved.path,
        path: ".hidden/sdk.bin", update_references: false }
    });
  assert.equal(hiddenMove.status, 400);

  const readOnly = { id: randomUUID(), token: `reader-${randomUUID()}-${randomUUID()}` };
  await internal(provider.url, `/internal/v1/collections/${collectionId}/replicas`, {
    replica_id: readOnly.id, name: "File reader", purpose: "mirror", mode: "read_only",
    allowed_types: [], contract_scope: [], full_collection: false,
    allowed_operations: [], token: readOnly.token
  });
  const deniedDelete = await request(provider.url,
    `/v1/authorities/${collectionId}/files/${moved.file_id}/delete`, {
      method: "POST", token: readOnly.token,
      body: { protocol_version: 1, type: "delete_file", mutation_id: randomUUID(),
        file_id: moved.file_id, if_revision: moved.revision, path: moved.path }
    });
  assert.equal(deniedDelete.status, 403);

  const revocationTransferId = randomUUID();
  const revocationSession = await json(
    provider.url,
    `/v1/authorities/${collectionId}/files/downloads`,
    readOnly.token,
    {
      protocol_version: 1,
      type: "open_file_download",
      transfer_id: revocationTransferId,
      file_id: largeUpload.receipt.file.file_id,
      revision: largeUpload.receipt.file.revision
    }
  );
  assert.equal(revocationSession.strategy.kind, "object_ranges");
  assert.ok((await fetch(
    `${provider.url}/v1/authorities/${collectionId}/files/downloads/${revocationTransferId}/parts/0`,
    { headers: { authorization: `Bearer ${readOnly.token}` } }
  )).ok);
  assert.equal((await request(
    provider.url,
    `/internal/v1/replicas/${readOnly.id}`,
    { method: "DELETE", token: internalToken }
  )).status, 204);
  const revokedRange = await request(
    provider.url,
    `/v1/authorities/${collectionId}/files/downloads/${revocationTransferId}/parts/1`,
    { token: readOnly.token }
  );
  assert.equal(revokedRange.status, 401);
  const revokedRecordRead = await request(
    provider.url,
    `/v1/authorities/${collectionId}/sync/changes?after=0&limit=1`,
    { token: readOnly.token }
  );
  assert.equal(revokedRecordRead.status, 401);

  const deleteMutationId = randomUUID();
  const deleted = await sdk.delete(moved, { mutationId: deleteMutationId });
  assert.equal(deleted.previous_path, moved.path);
  assert.deepEqual(await sdk.delete(moved, { mutationId: deleteMutationId }), deleted);
  assert.equal(await pg(`SELECT count(*) FROM hosted_provider_files WHERE file_id = '${moved.file_id}'`), "0");
  assert.deepEqual(await download(provider.url, collectionId, writer.token, moved), sdkBytes);

  const listed = await ok(request(provider.url,
    `/v1/authorities/${collectionId}/files?protocol_version=1`, { token: writer.token }));
  assert.deepEqual(listed.files.map((file) => file.path).sort(), ["Assets/small.bin", "Media/large.bin"]);
  assert.deepEqual(await download(provider.url, collectionId, writer.token, smallUpload.receipt.file), small);
  assert.deepEqual(await download(provider.url, collectionId, writer.token, largeUpload.receipt.file), large);

  const session = await json(provider.url,
    `/v1/authorities/${collectionId}/sync/sessions`, writer.token, {});
  const fileSnapshot = await ok(request(provider.url,
    `/v1/authorities/${collectionId}/sync/files/snapshot?snapshot_id=${session.snapshot_id}`,
    { token: writer.token }));
  assert.equal(fileSnapshot.files.length, 2);
  const changes = await ok(request(provider.url,
    `/v1/authorities/${collectionId}/sync/changes?after=0&limit=100`, { token: writer.token }));
  assert.deepEqual(changes.events.map((event) => event.type), ["file_put", "file_put", "file_put", "file_put", "file_remove"]);

  assert.equal((await mc("find", `local/${bucket}`)).trim().split("\n").filter((line) => line.includes("/v1/blobs/")).length, 3);
  await internal(provider.url, `/internal/v1/collections/${collectionId}/compact`, { through: 4 });
  assert.equal((await mc("find", `local/${bucket}`)).trim().split("\n").filter((line) => line.includes("/v1/blobs/")).length, 3);
  await internal(provider.url, `/internal/v1/collections/${collectionId}/compact`, { through: 5 });
  assert.equal((await mc("find", `local/${bucket}`)).trim().split("\n").filter((line) => line.includes("/v1/blobs/")).length, 2);
  const accounting = await pg(`SELECT file_count || ':' || file_bytes || ':' || stored_file_bytes FROM hosted_provider_collections WHERE id = '${collectionId}'`);
  assert.equal(accounting, `2:${small.length + large.length}:${small.length + large.length}`);

  const bad = Buffer.from("wrong bytes");
  const badTransfer = randomUUID();
  const badOpen = await json(provider.url, `/v1/authorities/${collectionId}/files/uploads`, writer.token, {
    protocol_version: 1, type: "open_file_upload", transfer_id: badTransfer,
    path: "bad.bin", size: bad.length, content_digest: digest(Buffer.from("expected"))
  });
  const badPart = await json(provider.url,
    `/v1/authorities/${collectionId}/files/uploads/${badTransfer}/parts`, writer.token, {
      protocol_version: 1, type: "prepare_file_upload_part", transfer_id: badTransfer,
      part_number: 1, content_length: bad.length
    });
  assert.ok((await fetch(badPart.url, { method: badPart.method, headers: badPart.headers, body: bad })).ok);
  const badCommit = await request(provider.url,
    `/v1/authorities/${collectionId}/files/uploads/${badTransfer}/commit`, {
      method: "POST", token: writer.token,
      body: { protocol_version: 1, type: "commit_file_upload", transfer_id: badTransfer, parts: [] }
    });
  assert.equal(badCommit.status, 400);
  assert.equal(badCommit.body.error.code, "file_content_mismatch");
  assert.equal((await request(provider.url,
    `/v1/authorities/${collectionId}/files/transfers/${badTransfer}`,
    { method: "DELETE", token: writer.token })).status, 200);
  assert.equal((await request(provider.url, `/v1/authorities/${collectionId}/files/uploads`, {
    method: "POST", token: writer.token,
    body: { protocol_version: 1, type: "open_file_upload", transfer_id: randomUUID(),
      path: ".hidden/file.bin", size: 0, content_digest: digest(Buffer.alloc(0)) }
  })).status, 400);

  const plaintextPaths = await pg(`SELECT count(*) FROM hosted_provider_files WHERE encode(payload_ciphertext, 'escape') LIKE '%Assets/small.bin%'`);
  assert.equal(plaintextPaths, "0");
  const plaintextMutations = await pg(`SELECT count(*) FROM hosted_provider_file_mutations WHERE encode(request_ciphertext, 'escape') LIKE '%sdk-renamed%' OR encode(receipt_ciphertext, 'escape') LIKE '%sdk-renamed%'`);
  assert.equal(plaintextMutations, "0");
  assert.equal(await pg("SELECT count(*) FROM hosted_provider_file_mutations"), "2");
  const objectsAfterCommit = await mc("find", `local/${bucket}`);
  assert.equal(objectsAfterCommit.includes("/v1/staging/"), false);
  assert.equal(objectsAfterCommit.trim().split("\n").filter((line) => line.includes("/v1/blobs/")).length, 2);
  process.stdout.write("mdbase hosted file PostgreSQL + S3 e2e passed\n");
} finally {
  if (provider && provider.exitCode === null) provider.kill("SIGTERM");
  await execute("docker", ["rm", "-f", postgres, objects]).catch(() => {});
}

async function upload(url, collectionId, token, path, bytes) {
  const transferId = randomUUID();
  const body = { protocol_version: 1, type: "open_file_upload", transfer_id: transferId,
    path, size: bytes.length, content_digest: digest(bytes) };
  const open = await json(url, `/v1/authorities/${collectionId}/files/uploads`, token, body);
  assert.deepEqual(await json(url, `/v1/authorities/${collectionId}/files/uploads`, token, body), open);
  const partSize = (open.strategy.part_size ?? bytes.length) || 1;
  const parts = [];
  for (let offset = 0, number = 1; offset < bytes.length || (bytes.length === 0 && number === 1); offset += partSize, number += 1) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + partSize));
    const prepared = await json(url, `/v1/authorities/${collectionId}/files/uploads/${transferId}/parts`, token, {
      protocol_version: 1, type: "prepare_file_upload_part", transfer_id: transferId,
      part_number: number, content_length: chunk.length
    });
    const response = await fetch(prepared.url, { method: prepared.method, headers: prepared.headers, body: chunk });
    assert.ok(response.ok, await response.text());
    if (open.strategy.kind === "object_multipart") {
      if (number === 1) {
        const resumed = await json(
          url,
          `/v1/authorities/${collectionId}/files/uploads`,
          token,
          body
        );
        assert.deepEqual(resumed.received, [0]);
        assert.deepEqual(resumed.uploaded_parts, [{
          part_number: 1,
          etag: response.headers.get("etag")
        }]);
        parts.push(...resumed.uploaded_parts);
      } else {
        parts.push({ part_number: number, etag: response.headers.get("etag") });
      }
    }
    if (bytes.length === 0) break;
  }
  const receipt = await json(url, `/v1/authorities/${collectionId}/files/uploads/${transferId}/commit`, token,
    { protocol_version: 1, type: "commit_file_upload", transfer_id: transferId, parts });
  return { transferId, open, receipt };
}

async function download(url, collectionId, token, file) {
  if (file.size === 0) return Buffer.alloc(0);
  const transferId = randomUUID();
  const open = await json(url, `/v1/authorities/${collectionId}/files/downloads`, token, {
    protocol_version: 1, type: "open_file_download", transfer_id: transferId,
    file_id: file.file_id, revision: file.revision
  });
  const chunks = [];
  for (let index = 0; index * open.strategy.part_size < file.size; index += 1) {
    const response = await fetch(`${url}/v1/authorities/${collectionId}/files/downloads/${transferId}/parts/${index}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    chunks.push(Buffer.from(await response.arrayBuffer()));
  }
  const bytes = Buffer.concat(chunks);
  assert.equal(digest(bytes), file.content_digest);
  return bytes;
}

function fileSdk(url, collectionId, token) {
  return new MdbaseFileClient(
    () => ({
      kind: "files",
      protocol_version: 1,
      actions: ["list", "read", "add", "replace", "move", "delete"],
      scope: { kind: "collection" }
    }),
    async (method, path = "", input) => ok(request(
      url,
      `/v1/authorities/${collectionId}/files${path === "" || path.startsWith("?") ? path : `/${path}`}`,
      { method, token, ...(input === undefined ? {} : { body: input }) }
    )),
    undefined,
    {
      async downloadPart(session, partIndex, expectedLength) {
        const response = await fetch(
          `${url}/v1/authorities/${collectionId}/files/downloads/${session.transfer_id}/parts/${partIndex}`,
          { headers: { authorization: `Bearer ${token}` } }
        );
        if (!response.ok) throw new Error(`Hosted range failed with HTTP ${response.status}.`);
        assert.equal(Number(response.headers.get("content-length")), expectedLength);
        assert.ok(response.body, "Hosted range did not return a response stream.");
        return response.body;
      }
    }
  );
}

function digest(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
async function json(url, path, token, body) { return ok(request(url, path, { method: "POST", token, body })); }
async function internal(url, path, body) { return ok(request(url, path, { method: "POST", token: internalToken, body })); }
async function ok(promise) { const response = await promise; if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(response.body)}`); return response.body; }
async function request(url, path, options = {}) {
  const headers = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let body;
  if (options.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(options.body); }
  const response = await fetch(`${url}${path}`, { method: options.method ?? "GET", headers, body });
  const text = await response.text();
  return { ok: response.ok, status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function startPostgres() {
  await execute("docker", ["run", "--rm", "-d", "--name", postgres, "-e", "POSTGRES_USER=mdbase", "-e", `POSTGRES_PASSWORD=${password}`, "-e", "POSTGRES_DB=mdbase", "-p", "127.0.0.1::5432", "postgres:18-alpine"]);
  const port = (await execute("docker", ["port", postgres, "5432/tcp"])).stdout.match(/:(\d+)/)[1];
  for (let i = 0; i < 120; i += 1) { if (await execute("docker", ["exec", postgres, "pg_isready", "-U", "mdbase"]).then(() => true, () => false)) return `postgres://mdbase:${password}@127.0.0.1:${port}/mdbase`; await delay(250); }
  throw new Error("PostgreSQL did not start");
}
async function startObjects() {
  await execute("docker", ["run", "--rm", "-d", "--name", objects, "-e", `MINIO_ROOT_USER=${objectAccess}`, "-e", `MINIO_ROOT_PASSWORD=${objectSecret}`, "-p", "127.0.0.1::9000", "minio/minio:RELEASE.2025-09-07T16-13-09Z", "server", "/data", "--address", ":9000"]);
  const port = (await execute("docker", ["port", objects, "9000/tcp"])).stdout.match(/:(\d+)/)[1];
  for (let i = 0; i < 120; i += 1) { if (await fetch(`http://127.0.0.1:${port}/minio/health/ready`).then(r => r.ok, () => false)) break; await delay(250); }
  await mc("mb", "--ignore-existing", `local/${bucket}`);
  return `http://127.0.0.1:${port}`;
}
async function mc(...args) { return (await execute("docker", ["run", "--rm", "--network", `container:${objects}`, "--entrypoint", "/bin/sh", "minio/mc:RELEASE.2025-08-13T08-35-41Z", "-c", `mc alias set local http://127.0.0.1:9000 ${objectAccess} ${objectSecret} >/dev/null && mc ${args.join(" ")}`])).stdout; }
async function startProvider(databaseUrl, endpoint) {
  const child = spawn(providerBinary, [], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl, MDBASE_CONNECT_HOSTED_PROVIDER_INTERNAL_TOKEN: internalToken, MDBASE_CONNECT_HOSTED_PROVIDER_MASTER_KEY: masterKey, MDBASE_CONNECT_R2_ENDPOINT: endpoint, MDBASE_CONNECT_R2_BUCKET: bucket, MDBASE_CONNECT_R2_ACCESS_KEY_ID: objectAccess, MDBASE_CONNECT_R2_SECRET_ACCESS_KEY: objectSecret, MDBASE_CONNECT_ALLOW_INSECURE_R2: "true", HOST: "127.0.0.1", PORT: "0", RUST_LOG: "warn" }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = ""; child.stderr.on("data", chunk => { logs += chunk; });
  child.url = await new Promise((resolveUrl, reject) => { child.stdout.on("data", chunk => { logs += chunk; const match = logs.match(/HOSTED_PROVIDER_LISTENING=(http:\/\/\S+)/); if (match) resolveUrl(match[1]); }); child.once("exit", code => reject(new Error(`provider exited ${code}: ${logs}`))); });
  return child;
}
async function pg(sql) { return (await execute("docker", ["exec", postgres, "psql", "-U", "mdbase", "-d", "mdbase", "-tA", "-c", sql])).stdout.trim(); }
function delay(ms) { return new Promise(resolveDelay => setTimeout(resolveDelay, ms)); }
