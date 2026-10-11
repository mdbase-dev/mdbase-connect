import {authorizationContractRequirements,authorizationFiles,authorizationOperations,semanticContractVersion} from "@mdbase-dev/connect-protocol";
import {parseVersionedAppManifest} from "@mdbase-dev/connect-protocol/manifest";
import {plainApplicationManifest,type ApplicationDeclarationSnapshot} from "./declaration.js";

function frozen<T>(value:T):Readonly<T>{
  if(value!==null&&typeof value==="object"){
    for(const child of Object.values(value))frozen(child);
    Object.freeze(value);
  }
  return value;
}
/** Internal projection of the ONE canonical public parser/compiler. This module
 * has no capability→operation table, parser, permission defaults, or selection
 * widening. Registration/native authority/catalog readiness remain separate. */
export function compileApplicationManifest(declaration:Readonly<ApplicationDeclarationSnapshot>){
  const versioned=parseVersionedAppManifest(plainApplicationManifest(declaration),{allowLocal:declaration.environment==="lab"});
  const manifest=frozen(versioned.manifest),requirements=manifest.requirements;
  const semanticVersion=semanticContractVersion(requirements);
  const operations=frozen(authorizationOperations(manifest,{}));
  const files=authorizationFiles(requirements);
  // This helper defaults to semantic v2. Always supply the ORIGINAL version,
  // including the predecessor bare full_collection/read-only v1 declaration.
  const contracts=frozen(authorizationContractRequirements(operations,files,undefined,semanticVersion));
  const capabilities=requirements.capabilities;
  const nativeCapabilities=capabilities?.contract_version===2?
    Object.freeze({capabilityContractVersion:2 as const,requiredNativeCapabilities:Object.freeze([...capabilities.required])}):null;
  return Object.freeze({contractVersion:versioned.contractVersion,manifest,semanticVersion,operations,
    ...(files?{files:frozen(files)}:{}),contracts,nativeCapabilities});
}
