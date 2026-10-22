/** Native's bounded review DTO is data, never app-side setup authority. */
import { decode, encode, Float64, type CborValue } from "../cbor.js";
import { mdbaseError } from "../errors.js";
import { resourceAssessment, type AppResourceAssessment } from "../app-host/collection-control.js";
import { receipt, type Receipt } from "../wire.js";
import type { Session } from "../session.js";
const bad=()=>mdbaseError("internal","Invalid Native setup reply.","declared_setup_codec");
export const hex=(b:Uint8Array)=>Array.from(b,v=>v.toString(16).padStart(2,"0")).join("");
export function hashBytes(s:string):Uint8Array {
  if(!/^sha256:[a-f0-9]{64}$/.test(s)) throw bad();
  return Uint8Array.from(s.slice(7).match(/../g)!,v=>parseInt(v,16));
}
function numeric(v:CborValue|undefined):Map<number,CborValue>{if(!(v instanceof Map)||[...v.keys()].some(k=>typeof k!=="number"))throw bad();return v as Map<number,CborValue>;}
function fixed(v:CborValue|undefined,n:number):Uint8Array {if(!(v instanceof Uint8Array)||v.length!==n)throw bad();return v.slice();}
function object(v:CborValue):unknown {
  if(v instanceof Float64)return v.value;
  if(v instanceof Map){if([...v.keys()].some(k=>typeof k!=="string"))throw bad();return Object.fromEntries([...v].map(([k,x])=>[k,object(x)]));}
  if(Array.isArray(v))return v.map(object);
  if(v===null || ["string","boolean","number"].includes(typeof v)) return v;
  throw bad();
}
export interface NativeSetupReview {
  readonly kind:"review"; readonly ticket:Uint8Array; readonly revision:Uint8Array;
  readonly assessment:AppResourceAssessment; readonly declaration:string; readonly application:string;
  readonly promoted:number; readonly retained:number; readonly records:readonly {path:string;action:"create"|"skip"}[];
}
export type NativeSetupReply=NativeSetupReview|{kind:"pending";ticket:Uint8Array}|{kind:"receipt";receipt:Receipt}|{kind:"cancelled"};
export async function setupRequest(s:Session,action:string,fields:readonly (readonly [number,CborValue])[],signal?:AbortSignal):Promise<NativeSetupReply> {
  const input=encode(new Map([[0,1],[1,action],...fields].sort(([a],[b])=>Number(a)-Number(b)) as [number,CborValue][]));
  let bytes:Uint8Array|undefined;
  try {
    bytes=await s.declaredSetup(input,signal);
    const m=numeric(decode(bytes)); if(m.get(0)!==1)throw bad();
    const kind=m.get(1),expected=kind==="review"?[0,1,2,3,4,5,6,7,8,9,10]:kind==="pending"?[0,1,2]:kind==="receipt"?[0,1,3]:kind==="cancelled"?[0,1]:[];
    if(m.size!==expected.length||expected.some(k=>!m.has(k)))throw bad();
    if(kind==="cancelled") return {kind};
    if(kind==="receipt")return {kind,receipt:receipt.dec(m.get(3)!)};
    const ticket=fixed(m.get(2),16);
    if(kind==="pending")return {kind,ticket};
    if(kind!=="review"||!["ready","setup_required","incompatible"].includes(m.get(3) as string)||typeof m.get(8)!=="string")throw bad();
    const impact=numeric(m.get(9)),rows=m.get(10);
    if(!(impact instanceof Map)||impact.size!==2||![impact.get(0),impact.get(1)].every(n=>Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<=256)||!Array.isArray(rows)||rows.length>32)throw bad();
    const records=rows.map(row=>{const r=numeric(row);if(r.size!==2||typeof r.get(0)!=="string"||!["create","skip"].includes(r.get(1) as string))throw bad();return Object.freeze({path:r.get(0) as string,action:r.get(1) as "create"|"skip"});});
    return {kind,ticket,revision:fixed(m.get(4),32),declaration:hex(fixed(m.get(7),32)),application:m.get(8) as string,
      promoted:impact.get(0) as number,retained:impact.get(1) as number,records:Object.freeze(records),
      assessment:resourceAssessment({status:m.get(3)==="ready"?"current":m.get(3)==="incompatible"?"conflict":"provision",assessmentDigest:"sha256:"+hex(fixed(m.get(5),32)),review:object(m.get(6)!)},true)};
  } finally{input.fill(0);bytes?.fill(0);}
}
