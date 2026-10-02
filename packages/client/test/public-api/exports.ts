import {
  MdbaseBrowserSelection,
  MdbaseConnect,
  externalStore,
  linksTo,
  type ReadManyOptions,
  type ReadManyResult,
  type ReadManyRecord,
  type ConnectRequestOptions,
  type CollectionFileDescriptor,
  type CollectionDescription,
  type MdbaseConnection,
  type MdbaseApplicationSessionSnapshot,
  type MdbaseDesiredTimer,
  type QueryInput,
  type UpdateInput
} from "@mdbase-dev/connect";
import {
  MdbaseCollectionClient,
  createPkce,
  type MdbaseCollectionTransport,
  type MdbaseSessionSnapshot
} from "@mdbase-dev/connect/advanced";
import {
  IndexedDbGrantKeyStore,
  MemoryApplicationIdentityStore
} from "@mdbase-dev/connect/crypto";

void MdbaseConnect;
void MdbaseBrowserSelection;
void externalStore;
void MdbaseCollectionClient;
void createPkce;
void IndexedDbGrantKeyStore;
void MemoryApplicationIdentityStore;
void (null as ConnectRequestOptions | MdbaseConnection | MdbaseCollectionTransport | null);
void (null as MdbaseSessionSnapshot | null);

const canonicalQuery: QueryInput = {
  types: ["note"],
  where: "status == 'open'",
  orderBy: [{ field: "file.mtime", direction: "desc" }],
  includeBody: false,
  frontmatterMode: "both"
};
const revisionSafeUpdate: UpdateInput = {
  path: "Notes/one.md",
  patch: { status: "done" },
  ifRevision: "sha256:old",
  includeDocument: true
};
const timer: MdbaseDesiredTimer = {
  id: "note:one",
  fireAt: "2026-08-06T00:00:00Z"
};
const file: CollectionFileDescriptor = {
  fileId: "01911111-1111-7111-8111-111111111111",
  path: "Assets/one.png",
  revision: "file:1",
  contentDigest: `sha256:${"0".repeat(64)}`,
  size: 1,
  mediaClass: "image",
  modifiedAt: "2026-08-06T00:00:00Z"
};
const description: CollectionDescription = {
  protocolVersion: 1,
  collectionId: "01911111-1111-7111-8111-111111111111",
  displayName: "Notes",
  specVersion: "0.3.0",
  operations: ["describe"],
  changeCursor: 0,
  types: [],
  contracts: []
};
void canonicalQuery;
void revisionSafeUpdate;
void timer;
void file;
void description;

export async function typedBatchReads(connection: MdbaseConnection<{ title: string }>): Promise<void> {
  const options: ReadManyOptions = { includeBody: true, frontmatterMode: "both", types: ["note"], concurrency: 2 };
  const outcome = await connection.readMany(["one.md", "missing.md"] as const, options);
  if (!outcome.ok) return;
  const result: ReadManyResult<{ title: string }> = outcome.value;
  for (const entry of result.results) {
    if (entry.status === "found") {
      const record: ReadManyRecord<{ title: string }> = entry.record;
      const revision: string | undefined = record.revision;
      // @ts-expect-error negotiated projections are still not full documents.
      const document: import("@mdbase-dev/connect").RecordDocument<{ title: string }> = record;
      void document;
      const title: string | undefined = record.frontmatter?.title;
      void revision; void title;
    } else if (entry.status === "error") {
      void result.errors.find(error => error.batch === entry.batch)?.failure.problem;
    } else {
      void entry.path;
    }
  }
  await connection.queryAll({ where: linksTo("source", "sources/book.md") }, { pageSize: 1_000, maxResults: 500 });
  connection.executeViewPages({ path: "views.md", view: "all" }, { pageSize: 100, maxResults: 200 });
  // @ts-expect-error raw path batches cannot select contract views.
  connection.readMany(["one.md"], { contract: { id: "example", version: "1" } });
}

export function renderLifecycle(snapshot: MdbaseApplicationSessionSnapshot): string {
  if (snapshot.status === "not_started") return "Start";
  if (snapshot.status === "starting") return "Starting";
  if (snapshot.status === "start_failed") return snapshot.problem.message;
  if (snapshot.status === "destroyed") return "Closed";
  return snapshot.status;
}

// @ts-expect-error wire spelling is rejected at the application boundary.
const wireQueryTypo: QueryInput = { order_by: [{ field: "file.path" }] };
// @ts-expect-error canonical queries use a CEL string, not an untyped filter object.
const malformedWhere: QueryInput = { where: { status: "open" } };
// @ts-expect-error unknown query keys no longer compile.
const misspelledQuery: QueryInput = { incldueBody: true };
// @ts-expect-error mutation preconditions use camelCase.
const wireUpdateTypo: UpdateInput = { path: "one.md", patch: {}, if_revision: "old" };
// @ts-expect-error file identities use camelCase at the SDK boundary.
const wireFileTypo: CollectionFileDescriptor = { file_id: "one" };
// @ts-expect-error collection descriptions are mapped at the SDK boundary.
const wireDescriptionTypo: CollectionDescription = { protocol_version: 1 };
void wireQueryTypo;
void malformedWhere;
void misspelledQuery;
void wireUpdateTypo;
void wireFileTypo;
void wireDescriptionTypo;

export async function compiledQuickstart(
  connect: InstanceType<typeof MdbaseConnect>,
  lifetime: AbortController
): Promise<void> {
  void connect.connectionApplicationId("01911111-1111-7111-8111-111111111111");
  const session = connect.application({ selection: new MdbaseBrowserSelection() });
  const started = await session.start({ signal: lifetime.signal, timeoutMs: 20_000 });
  if (!started.ok) {
    void started.problem.recovery;
    return;
  }
  if (session.getSnapshot().status === "unselected") {
    const authorized = await session.authorize("choose", {
      signal: lifetime.signal,
      timeoutMs: 20_000
    });
    if (!authorized.ok) return;
  }
  const connection = session.connection();
  if (!connection) return;
  const queried = await connection.query({ types: ["workout"] }, {
    signal: lifetime.signal,
    timeoutMs: 8_000
  });
  if (!queried.ok || !queried.value.results[0]) return;
  const current = await connection.read({ path: queried.value.results[0].path });
  if (!current.ok) return;
  const updated = await connection.update({
    path: current.value.path,
    patch: { completed: true },
    ifRevision: current.value.revision
  });
  if (!updated.ok && updated.problem.operation_outcome === "unknown") {
    for (const pending of connection.pendingMutations()) {
      await pending.recover({ signal: lifetime.signal, timeoutMs: 30_000 });
    }
  }
  const watched = await connection.watch(
    { lifetimeSignal: lifetime.signal },
    { signal: lifetime.signal, timeoutMs: 20_000 }
  );
  if (watched.ok) {
    watched.value.subscribe((change) => {
      if (change.kind === "record.updated") {
        const path: string = change.path;
        const changedFields: string[] | undefined = change.changedFields;
        const revision: string | undefined = change.previousRevision;
        void [path, changedFields, revision, change.raw.payload];
      } else if (change.kind === "record.renamed") {
        const paths: [string, string] = [change.from, change.to];
        void paths;
      } else if (change.kind === "file.put") {
        const fileId: string = change.file.fileId;
        void fileId;
      } else if (change.kind === "unknown") {
        const reason: "unrecognized_type" | "invalid_payload" = change.reason;
        void reason;
      }
    });
    watched.value.close();
  }
  const generation: number = connection.schemaGeneration;
  const described = await connection.describe({ fresh: true, signal: lifetime.signal });
  void [generation, described];
  const cleared = session.clearSelection();
  if (!cleared.ok) void cleared.problem.recovery;
}

// @ts-expect-error low-level clients do not belong to the golden-path root.
import { MdbaseCollectionClient as RemovedRootClient } from "@mdbase-dev/connect";
// @ts-expect-error PKCE plumbing is an advanced concern.
import { createPkce as RemovedRootPkce } from "@mdbase-dev/connect";
// @ts-expect-error cryptographic storage is only exported from /crypto.
import { IndexedDbGrantKeyStore as RemovedRootKeyStore } from "@mdbase-dev/connect";

void RemovedRootClient;
void RemovedRootPkce;
void RemovedRootKeyStore;

// @ts-expect-error outcome construction belongs to @mdbase-dev/connect-testing.
import { connectSuccess as RemovedOutcomeBuilder } from "@mdbase-dev/connect";
// @ts-expect-error problem construction belongs to @mdbase-dev/connect-testing.
import { connectProblem as RemovedProblemBuilder } from "@mdbase-dev/connect";
// @ts-expect-error outcome throwing adapters are not part of the typed golden path.
import { unwrapConnectOutcome as RemovedOutcomeAdapter } from "@mdbase-dev/connect";
// @ts-expect-error request budgets are internal implementation machinery.
import type { RequestBudget as RemovedRequestBudget } from "@mdbase-dev/connect";
// @ts-expect-error connection construction is an advanced/internal seam.
import type { MdbaseConnectionInternals as RemovedConnectionInternals } from "@mdbase-dev/connect";
// @ts-expect-error transport construction is only available from /advanced.
import type { MdbaseCollectionTransport as RemovedCollectionTransport } from "@mdbase-dev/connect";

declare const ordinaryConnection: MdbaseConnection;
// @ts-expect-error ordinary application connections expose only typed operations.
ordinaryConnection.operation("query", {});

void RemovedOutcomeBuilder;
void RemovedProblemBuilder;
void RemovedOutcomeAdapter;
void (null as RemovedRequestBudget | RemovedConnectionInternals | RemovedCollectionTransport | null);
