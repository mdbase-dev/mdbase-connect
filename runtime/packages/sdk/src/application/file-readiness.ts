import type {FileGrant} from "../files.js";
import type {MdbaseApplicationFacetSnapshot} from "./entry.js";
import type {FileAccessDeclaration} from "./file-access.js";
import type {ApplicationReadinessFacetSource} from "./readiness.js";

export interface ApplicationFileReadinessOptions {
  /** Null when the manifest declares no files: nothing to assess. */
  readonly declaration:FileAccessDeclaration|null;
  /** Declared `requirements.files.scope.kind`; "collection" needs the whole file namespace. */
  readonly scope:string|null;
  /** The open connection's current file grant (null: the producer does not report its scope). */
  grant():FileGrant|null;
  isCurrent():boolean;
}
const facet=(value:MdbaseApplicationFacetSnapshot)=>Object.freeze(value);
const READY=facet({checking:false,assessment:Object.freeze({status:"ready",problem:null}),problem:null});
const FENCED=facet({checking:false,assessment:null,problem:Object.freeze({code:"files_fenced"})});
const UNAVAILABLE=facet({checking:false,assessment:null,problem:Object.freeze({code:"files_unavailable"})});
const incompatible=(code:string)=>facet({checking:false,assessment:Object.freeze({status:"incompatible",problem:Object.freeze({code})}),problem:null});

/** Files facet from the open connection's own grant. Optional actions are asked
 * for at the moment of use (requestAccess), so only required actions count. An
 * unreported grant scope is not a refusal: the replica still checks every call. */
export function createApplicationFileReadiness(input:ApplicationFileReadinessOptions):ApplicationReadinessFacetSource {
  const listeners=new Set<()=>void>();let closed=false;
  const assess=():MdbaseApplicationFacetSnapshot=>{
    if(closed||!input.isCurrent())return FENCED;
    const declaration=input.declaration;
    if(!declaration)return READY;
    let grant:FileGrant|null;
    try{grant=input.grant();}catch{return UNAVAILABLE;}
    if(!grant)return READY;
    if(declaration.required.some(action=>!grant.actions.includes(action)))return incompatible("files_access_missing");
    if(input.scope==="collection"&&grant.scope.kind!=="collection")return incompatible("files_scope_missing");
    return READY;
  };
  let value=assess();
  return Object.freeze({
    getSnapshot:()=>closed||!input.isCurrent()?FENCED:value,
    subscribe(listener:()=>void){if(closed)return()=>{};listeners.add(listener);return()=>{listeners.delete(listener);};},
    async refresh(){
      const next=assess();
      if(next!==value){value=next;for(const listener of [...listeners])try{listener();}catch{/* observers do not own evidence */}}
      return value;
    },
    close(){closed=true;listeners.clear();},
  });
}
