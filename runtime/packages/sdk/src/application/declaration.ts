import {mdbaseError} from "../errors.js";

export type ApplicationJson=null|boolean|number|string|readonly ApplicationJson[]|{readonly[key:string]:ApplicationJson};
export interface ApplicationStorageDeclaration {
  readonly joinDatabaseName?:string;
  readonly setupDatabaseName?:string;
  readonly applicationNamespace?:string;
}
/** App data only: never trust roots, runtime loader, Worker/SQL callbacks, keys,
 * bearer, or authority ports. Existing registered application ID stays exact;
 * logical declaration identity is not an inferred CP registration receipt. */
export interface MdbaseApplicationDeclaration {
  readonly id:string;readonly name:string;readonly origin:string;
  readonly environment:"lab"|"production";
  /** Complete canonical manifest data; runtime validation uses the public
   * Connect parser. Accepts canonical typed builders without index-signature casts. */
  readonly manifest:unknown;
  readonly storage?:ApplicationStorageDeclaration;
}
export interface ApplicationDeclarationSnapshot extends Omit<MdbaseApplicationDeclaration,"storage"|"manifest"> {
  readonly manifest:Readonly<Record<string,ApplicationJson>>;
  readonly storage:Readonly<Required<ApplicationStorageDeclaration>>;
}
const storageOverrides=new WeakMap<Readonly<ApplicationDeclarationSnapshot>,Readonly<ApplicationStorageDeclaration>>();
/** SDK-only registration rebinding. Fresh defaults derive from registered ID;
 * supplied compatibility DATA stays exact, including supplied default-like values. */
export function rebindApplicationDeclaration(original:Readonly<ApplicationDeclarationSnapshot>,registered:{readonly id:string;readonly name:string}):Readonly<ApplicationDeclarationSnapshot>{
  const overrides=storageOverrides.get(original);
  if(!overrides||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(registered.id)||registered.id==="00000000-0000-0000-0000-000000000000")fail();
  return applicationDeclaration({...original,id:registered.id,name:registered.name,storage:overrides});
}
function fail():never{throw mdbaseError("invalid_request","invalid application declaration","application_declaration");}
function json(value:unknown,seen=new Set<object>(),depth=0,budget={nodes:0,chars:0}):ApplicationJson{
  if(++budget.nodes>524288||depth>64)fail();
  if(typeof value==="string"){budget.chars+=value.length;if(budget.chars>524288)fail();return value;}
  if(value===null||typeof value==="boolean")return value;
  if(typeof value==="number"){if(!Number.isFinite(value))fail();return value;}
  if(typeof value!=="object"||seen.has(value)||Object.getOwnPropertySymbols(value).length)fail();seen.add(value);
  try{
    if(Array.isArray(value)){
      if(value.length>524288||Object.keys(value).length!==value.length)fail();
      return Object.freeze(Array.from({length:value.length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!("value" in d))fail();return json(d.value,seen,depth+1,budget);}));
    }
    if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)fail();
    const copy:Record<string,ApplicationJson>=Object.create(null);
    for(const key of Object.keys(value)){
      budget.chars+=key.length;const d=Object.getOwnPropertyDescriptor(value,key);if(budget.chars>524288||!d||!("value" in d))fail();copy[key]=json(d.value,seen,depth+1,budget);
    }return Object.freeze(copy);
  }finally{seen.delete(value);}
}
/** Bounds/immutable JSON custody only. Manifest schema, permission/version intent
 * and registration remain the ONE canonical shared compiler/CP implementation. */
/** Validator input for the frozen snapshot manifest. The snapshot keeps its
 * null-prototype JSON objects; schema validators (AJV deep equality for
 * uniqueItems/const) need ordinary objects, so they get a plain JSON copy. */
export function plainApplicationManifest(declaration:Readonly<ApplicationDeclarationSnapshot>):unknown{
  return JSON.parse(JSON.stringify(declaration.manifest)) as unknown;
}
export function applicationDeclaration(input:MdbaseApplicationDeclaration):Readonly<ApplicationDeclarationSnapshot>{
  const data=json(input) as Record<string,ApplicationJson>;
  if(!data||Array.isArray(data)||Object.keys(data).some(key=>!["id","name","origin","environment","manifest","storage"].includes(key)))fail();
  const {id,name,origin,environment,manifest}=data;
  if(typeof id!=="string"||!id||id.length>256||!/^[a-z0-9][a-z0-9._-]*$/.test(id)||id==="00000000-0000-0000-0000-000000000000"
    ||typeof name!=="string"||!name.trim()||new TextEncoder().encode(name).length>100||/[\u0000-\u001f\u007f]/.test(name)
    ||typeof origin!=="string"||typeof environment!=="string"||!["lab","production"].includes(environment)||!manifest||Array.isArray(manifest)||typeof manifest!=="object")fail();
  let url:URL;try{url=new URL(origin);}catch{return fail();}
  const extension=["chrome-extension:","moz-extension:"].includes(url.protocol),loopback=["localhost","127.0.0.1","[::1]"].includes(url.hostname);
  if(url.username||url.password||(!["/",""].includes(url.pathname))||url.search||url.hash||(!extension&&url.origin!==origin)||(extension&&`${url.protocol}//${url.host}`!==origin)
    ||(!extension&&url.protocol!=="https:"&&!(environment==="lab"&&url.protocol==="http:"&&loopback)))fail();
  const override=data.storage;if(override!==undefined&&(!override||Array.isArray(override)||typeof override!=="object"||Object.keys(override).some(key=>!["joinDatabaseName","setupDatabaseName","applicationNamespace"].includes(key))))fail();
  const fields=override as Record<string,ApplicationJson>|undefined;
  const storage={joinDatabaseName:fields?.joinDatabaseName??`mdbase.${id}.native-collection-join.v1`,setupDatabaseName:fields?.setupDatabaseName??`mdbase.${id}.native-model-setup.v1`,applicationNamespace:fields?.applicationNamespace??id};
  for(const value of Object.values(storage))if(typeof value!=="string"||!value||value.length>256||/[\u0000-\u001f\u007f]/.test(value))fail();
  if(storage.joinDatabaseName===storage.setupDatabaseName)fail();
  const resolved=Object.freeze({id,name,origin,environment:environment as "lab"|"production",manifest:manifest as ApplicationDeclarationSnapshot["manifest"],storage:Object.freeze(storage as Required<ApplicationStorageDeclaration>)});
  storageOverrides.set(resolved,Object.freeze({...fields}) as Readonly<ApplicationStorageDeclaration>);return resolved;
}
