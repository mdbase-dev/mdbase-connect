import type { EngineOut } from "./engine.js";
/** Native hd_poll's exact canonical [[safe-session, bstr|null], ...] envelope.
 * Views borrow the OWNED JS copy, never WASM memory; no second frame/body copy.
 * This is not a client wire decoder or an admission/custody check.
 */
export function outputFrames(bytes: Uint8Array): EngineOut[] {
 let pos=0;
 function head(major:number):number {
  const first=bytes[pos++];
  if(first===undefined||first>>>5!==major)throw Error("invalid native output envelope");
  const info=first&31;
  if(info<24)return info;
  if(info>27)throw Error("invalid native output envelope");
  const count=1<<(info-24);if(pos+count>bytes.length)throw Error("truncated native output envelope");
  let value=0;for(let i=0;i<count;i++)value=value*256+bytes[pos++];
  const minimum=[24,256,65536,4294967296][info-24];
  if(value<minimum||!Number.isSafeInteger(value))throw Error("invalid native output integer");
  return value;
 }
 try {
  const count=head(4);if(count>bytes.length)throw Error("invalid native output count");
  const out:EngineOut[]=[];
  for(let i=0;i<count;i++) {
   if(head(4)!==2)throw Error("invalid native output row");
   const session=head(0);
   if(bytes[pos]===0xf6){pos++;out.push({session,frame:null});continue;}
   const length=head(2),end=pos+length;
   if(end>bytes.length)throw Error("truncated native output frame");
   out.push({session,frame:bytes.subarray(pos,end)});pos=end;
  }
  if(pos!==bytes.length)throw Error("trailing native output bytes");
  return out;
 } catch(error) {bytes.fill(0);throw error;}
}
