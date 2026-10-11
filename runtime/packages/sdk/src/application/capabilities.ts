import {applicationDeclaration,type MdbaseApplicationDeclaration} from "./declaration.js";
import {compileApplicationManifest} from "./manifest.js";
import {mdbaseError} from "../errors.js";
import type {MdbaseApplicationConnection} from "./entry.js";

export interface MdbaseApplicationCapability {
  readonly id:string;
  readonly requirement:"required"|"optional";
  readonly state:"available"|"missing";
}
export interface MdbaseApplicationCapabilities {
  /** Declared groups (required first, then optional), in declaration order. */
  readonly values:readonly MdbaseApplicationCapability[];
  readonly requiredAvailable:boolean;
  /** Declared groups the current grant lacks: show "update access", then reauthorize(). */
  readonly missing:readonly string[];
}
/** Prod `effectiveCapabilities`. Compares the declaration's v2 capability groups
 * with the current session's negotiated hello grant, for step-up UI only. It
 * does not refresh permissions or authorize an operation; native operation
 * checks remain authoritative. Reauthorization still requires user approval and
 * may return another restricted grant. Null without a v2 capability contract. */
export function effectiveCapabilities(declaration:MdbaseApplicationDeclaration,connection:Pick<MdbaseApplicationConnection,"records"|"isCurrent">):MdbaseApplicationCapabilities|null{
  const declared=compileApplicationManifest(applicationDeclaration(declaration)).manifest.requirements.capabilities;
  if(declared?.contract_version!==2)return null;
  if(!connection.isCurrent())throw mdbaseError("invalid_request","the application connection is not current","application_connection_fenced");
  const granted=new Set(connection.records.hello.grant.capabilities),required=new Set<string>(declared.required);
  const values=Object.freeze([...new Set<string>([...declared.required,...(declared.optional??[])])].map(id=>Object.freeze({
    id,requirement:required.has(id)?"required" as const:"optional" as const,state:granted.has(id)?"available" as const:"missing" as const})));
  return Object.freeze({values,requiredAvailable:values.every(v=>v.requirement==="optional"||v.state==="available"),
    missing:Object.freeze(values.filter(v=>v.state==="missing").map(v=>v.id))});
}
