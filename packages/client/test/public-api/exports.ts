import {
  MdbaseBrowserSelection,
  MdbaseConnect,
  externalStore,
  type ConnectRequestOptions,
  type MdbaseConnection
} from "@mdbase-dev/connect";
import {
  MdbaseCollectionClient,
  createPkce,
  type MdbaseCollectionTransport
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
