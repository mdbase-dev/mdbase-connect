/** Fixed, secret-free interpretation of a bounded append response; never authority. */
import { decode, type CborValue } from "../../../packages/sdk/src/cbor.ts";
const CODES = new Set(["unauthenticated","forbidden","not_found","gone","invalid","too_large","refs_missing","frozen","rate_limited","quota_exceeded","unavailable","upgrade_required"]);
const REASONS = new Set(["role","revoked","kind","shape","signature","epoch","rekey_required","frozen","chain","idem","expect_seq","expect_prev"]);
const OUTCOMES = new Set(["appended","head_moved","duplicate","refused","transport_error","http_error","malformed"]);
export interface AppendObservation { outcome: string; code?: string; reason?: string; http_status?: number; }
export function appendObservation(request: Uint8Array, reply: Uint8Array): AppendObservation {
 if (request.length > 64<<10 || reply.length > 64<<10) return {outcome:"malformed"};
 try {
  const rawQ=decode(request),rawR=decode(reply);
  if (!(rawQ instanceof Map) || !(rawR instanceof Map)) return {outcome:"malformed"};
  const q=rawQ as Map<number,CborValue>,r=rawR as Map<number,CborValue>;
  if (q.get(2)!=="append" || r.get(0)!==1 || r.get(1)!==q.get(1)) return {outcome:"malformed"};
  const rawError=r.get(3);
  if (rawError instanceof Map) {
   const error=rawError as Map<number,CborValue>;
   if (r.has(2)) return {outcome:"malformed"};
   const code=error.get(0),reason=error.get(1);
   return {outcome:"refused",code:typeof code==="string"&&CODES.has(code)?code:"other",reason:typeof reason==="string"&&REASONS.has(reason)?reason:"other"};
  }
  const result=r.get(2);
  if (!Array.isArray(result) || result.length!==2 || !(result[1] instanceof Map)) return {outcome:"malformed"};
  return {outcome:result[0]===0?"appended":result[0]===1?"head_moved":result[0]===2?"duplicate":"malformed"};
 } catch { return {outcome:"malformed"}; }
}
/** Validate again at the logging boundary, even if a caller violates TS types. */
export function boundedAppendObservation(value: AppendObservation): AppendObservation {
 const safe:AppendObservation={outcome:OUTCOMES.has(value.outcome)?value.outcome:"malformed"};
 if(value.code!==undefined)safe.code=CODES.has(value.code)?value.code:"other";
 if(value.reason!==undefined)safe.reason=REASONS.has(value.reason)?value.reason:"other";
 if(Number.isInteger(value.http_status)&&value.http_status!>=100&&value.http_status!<=599)safe.http_status=value.http_status;
 return safe;
}
