import { MdbaseCollectionClient } from "../../api-candidate/advanced.js";
import { MemoryGrantKeyStore } from "../../api-candidate/crypto.js";
import { MdbaseConnect } from "../../api-candidate/index.js";

void MdbaseCollectionClient;
void MemoryGrantKeyStore;
void MdbaseConnect;

// @ts-expect-error cryptographic construction is not a root export.
import { IndexedDbGrantKeyStore } from "../../api-candidate/index.js";
void IndexedDbGrantKeyStore;

// @ts-expect-error custom record transports are an advanced construction seam.
import type { MdbaseRecordSessionAdapter } from "../../api-candidate/index.js";
export type RootRecordAdapter = MdbaseRecordSessionAdapter<unknown>;
