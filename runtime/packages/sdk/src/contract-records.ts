/** Version-one contract-scoped single-record reads and write mapping. The
 * replica's Core maps fields; the SDK never projects or maps on its own. */
import { hash, list, struct, tstr, uint, uuid } from "./codec.js";
import { baseField, fmMap, type BaseField, type FmMap, type Uuid } from "./wire.js";

/** An exact registered record contract; `type` picks the implementing type
 * when several implement it. */
export interface ContractSelector { id: string; version: string; type?: string }

/** The exact contract and implementation a view or write went through. */
export interface ContractIdentity { id: string; version: string; digest: string; type: string; implementationDigest: string }

/** One record's valid contract view. */
export interface ContractRecordView {
  id: Uuid;
  path: string;
  revision: string;
  /** Contract fields, keyed by contract field name. */
  fields: FmMap;
  contract: ContractIdentity;
}

interface ContractRecordWire {
  version: number; id: Uuid; path: string; revision: string; type: string;
  fields: FmMap; contractDigest: string; implementationDigest: string;
}
export const contractRecordWire = struct<ContractRecordWire>("contract-record-v1", [
  [0, "version", uint], [1, "id", uuid], [2, "path", tstr], [3, "revision", hash], [4, "type", tstr],
  [5, "fields", fmMap], [6, "contractDigest", hash], [7, "implementationDigest", hash],
]);

/** A contract write as ordinary top-level record changes (SDK-internal). */
export interface ContractWritePlan {
  version: number; type: string; patch: FmMap; unset: string[]; base: BaseField[];
  contractDigest: string; implementationDigest: string;
  id?: Uuid; path?: string; revision?: string;
}
export const contractWritePlan = struct<ContractWritePlan>("contract-write-plan-v1", [
  [0, "version", uint], [1, "type", tstr], [2, "patch", fmMap], [3, "unset", list(tstr)],
  [4, "base", list(baseField)], [5, "contractDigest", hash], [6, "implementationDigest", hash],
  [7, "id", uuid, "opt"], [8, "path", tstr, "opt"], [9, "revision", hash, "opt"],
]);
