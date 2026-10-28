// HTTP operation proof only. No collection-log/wire item or key-trust statement.
import { domainHash, encodeCbor, uuidBytes } from "./policy-wire.js";
export function collectionModeDigest(input: {
  challenge: Uint8Array; connector: string; device: string; collection: string;
  request: string; target: "private" | "cloud_copy"; finish: boolean; epoch: bigint;
  seq: bigint; chain: Uint8Array; members: readonly string[];
}): Uint8Array {
  return domainHash("mdbase/v1/collection-mode", encodeCbor([
    input.challenge, uuidBytes(input.connector), uuidBytes(input.device),
    uuidBytes(input.collection), uuidBytes(input.request),
    input.target === "private" ? 0 : 1, input.finish, input.epoch, input.seq, input.chain, input.members.map(uuidBytes)
  ]));
}
