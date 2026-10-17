/** Fixed, secret-free interpretation of a bounded append response; never authority. */
import { decode, type CborValue } from "../../../packages/sdk/src/cbor.ts";
const CODES = new Set(["unauthenticated","forbidden","not_found","gone","invalid","too_large","refs_missing","frozen","rate_limited","quota_exceeded","unavailable","upgrade_required"]);
const REASONS = new Set(["role","revoked","kind","shape","signature","epoch","rekey_required","frozen","chain","idem","expect_seq","expect_prev"]);
const OUTCOMES = new Set(["appended","head_moved","duplicate","refused","transport_error","http_error","malformed"]);
const DETAILS = new Set(["size","decode","shape","method","version","id","error_with_result","result_shape","result_code"]);
export interface AppendObservation { outcome: string; code?: string; reason?: string; http_status?: number; detail?: string; }
const malformed = (detail: string): AppendObservation => ({outcome:"malformed",detail});
export function appendObservation(request: Uint8Array, reply: Uint8Array): AppendObservation {
 if (request.length > 64<<10 || reply.length > 64<<10) return malformed("size");
 try {
  let rawQ:CborValue,rawR:CborValue;
  try { rawQ=decode(request); rawR=decode(reply); } catch { return malformed("decode"); }
  if (!(rawQ instanceof Map) || !(rawR instanceof Map)) return malformed("shape");
  const q=rawQ as Map<number,CborValue>,r=rawR as Map<number,CborValue>;
  if (q.get(2)!=="append") return malformed("method");
  if (r.get(0)!==1) return malformed("version");
  if (r.get(1)!==q.get(1)) return malformed("id");
  const rawError=r.get(3);
  if (rawError instanceof Map) {
   const error=rawError as Map<number,CborValue>;
   if (r.has(2)) return malformed("error_with_result");
   const code=error.get(0),reason=error.get(1);
   return {outcome:"refused",code:typeof code==="string"&&CODES.has(code)?code:"other",reason:typeof reason==="string"&&REASONS.has(reason)?reason:"other"};
  }
  const result=r.get(2);
  // AppendResult is a wire union: the variant's struct map carries its tag at key 0.
  if (!(result instanceof Map)) return malformed("result_shape");
  const tag=(result as Map<number,CborValue>).get(0);
  return tag===0?{outcome:"appended"}:tag===1?{outcome:"head_moved"}:tag===2?{outcome:"duplicate"}:malformed("result_code");
 } catch { return malformed("decode"); }
}
/** Validate again at the logging boundary, even if a caller violates TS types. */
export function boundedAppendObservation(value: AppendObservation): AppendObservation {
 const safe:AppendObservation={outcome:OUTCOMES.has(value.outcome)?value.outcome:"malformed"};
 if(value.code!==undefined)safe.code=CODES.has(value.code)?value.code:"other";
 if(value.reason!==undefined)safe.reason=REASONS.has(value.reason)?value.reason:"other";
 if(value.detail!==undefined)safe.detail=DETAILS.has(value.detail)?value.detail:"other";
 if(Number.isInteger(value.http_status)&&value.http_status!>=100&&value.http_status!<=599)safe.http_status=value.http_status;
 return safe;
}
