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
