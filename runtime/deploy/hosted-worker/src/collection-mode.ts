/** Bounded, authenticated service completion requests. Never app admission. */
import { serviceAuthorization } from "./service-devices.ts";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const validId = (s: unknown): s is string => typeof s === "string" && UUID.test(s) && s !== "00000000-0000-0000-0000-000000000000";
export interface ModeServiceRequest { collection: string; device: string; epoch: string; challenge: string }
export const modeUnavailable = () => Response.json({error:"not_ready"}, {status:503,headers:{"cache-control":"no-store"}});
export async function modeServiceRequest(request: Request, token?: string): Promise<ModeServiceRequest | Response> {
  const denied = serviceAuthorization(request,token); if (denied) return denied;
  const reader = request.body?.getReader(); if (!reader) return modeUnavailable();
  const bytes = new Uint8Array(1024); let n = 0;
  try {
    for (;;) { const p = await reader.read(); if (p.done) break;
      if (p.value.length > bytes.length - n) { await reader.cancel(); return modeUnavailable(); }
      bytes.set(p.value,n); n += p.value.length;
    }
    const v: unknown = JSON.parse(new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(bytes.subarray(0,n)));
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== 4) return modeUnavailable();
    const b = v as Record<string,unknown>;
    if (!validId(b.collection) || !validId(b.device) || typeof b.epoch !== "string" || !/^[1-9][0-9]{0,19}$/u.test(b.epoch)
      || BigInt(b.epoch) >= 1n << 64n || typeof b.challenge !== "string" || !/^[0-9a-f]{64}$/u.test(b.challenge)) return modeUnavailable();
    return {collection:b.collection,device:b.device,epoch:b.epoch,challenge:b.challenge};
  } catch { return modeUnavailable(); } finally { reader.releaseLock(); }
}
export function modeReady(encoded: unknown, input: ModeServiceRequest): boolean {
  if (!Array.isArray(encoded) || encoded.length !== 2 || !(encoded[0] instanceof Uint8Array) || encoded[0].length !== 16) return false;
  const hex = Array.from(encoded[0], b=>b.toString(16).padStart(2,"0")).join("");
  const id = hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/u,"$1-$2-$3-$4-$5");
  const epoch = encoded[1];
  return id === input.device && (typeof epoch === "bigint" || typeof epoch === "number" && Number.isSafeInteger(epoch)) && BigInt(epoch) === BigInt(input.epoch);
}
export function modeAck(input: ModeServiceRequest) {
  return Response.json({...input,ready:true},{headers:{"cache-control":"no-store"}});
}
