/** TEST-ONLY public context for isolated native/SQLite carriers.
 * Not a signed trust-asset parser/verifier or production release authority.
 * Production pins must be produced by the SHARED build-time trust verifier.
 */
import { createHash } from "node:crypto";
export function appPolicyPinsFixture(rootPublicKey, policyPublicKey, encode) {
  const root = new Uint8Array(rootPublicKey), policy = new Uint8Array(policyPublicKey);
  if (root.length !== 32 || policy.length !== 32) throw Error("explicit public fixture keys required");
  const id = pk => new Uint8Array(createHash("sha256").update(pk).digest().subarray(0, 16));
  const rid = id(root);
  return encode([[[rid, root]], [[id(policy), policy, rid]]]);
}
