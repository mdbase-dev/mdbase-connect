import {selectAppEnvironment} from "../app-host/app-environment.js";
import type {AppBundledReleaseTrust} from "../app-host/cloud-copy-bootstrap.js";
import type {AppWebCollectionAdapterOptions,AppWebCollectionHandoff} from "../app-host/web-collection.js";
import type {AppCollectionSqlOptions} from "../app-storage/collection-sql.js";
import {applicationAssetLoader,type ApplicationAsset} from "./asset-loader.js";
import type {ApplicationDeclarationSnapshot} from "./declaration.js";

/** Private generated SDK packaging context. Never an application constructor
 * option. Release authentication and the ONE BUILD verifier precede this input;
 * no runtime discovery or new trust verifier exists here. */
export interface PackagedApplicationNativeAssets {
  release():AppBundledReleaseTrust;
  readonly runtime:ApplicationAsset;
  readonly sqlite:ApplicationAsset;
  /** Official pinned sqlite-wasm browser initializer bundled in SDK Worker. */
  readonly initializeSqlite:AppCollectionSqlOptions["initialize"];
}
/** Builds only internal SDK callbacks. The app receives declaration/lifecycle/
 * data access, never artifact URL/hash selection, initializer, SQL or trust. */
export function applicationNativeAssets(
  declaration:Readonly<ApplicationDeclarationSnapshot>,
  packaged:PackagedApplicationNativeAssets,
  handoff:(value:AppWebCollectionHandoff)=>void,
  fetcher?:typeof fetch,
){
  const released=packaged.release();
  const release:AppBundledReleaseTrust=Object.freeze({
    schema:released.schema,environment:released.environment,cpOrigin:released.cpOrigin,logOrigin:released.logOrigin,
    assetSha256:released.assetSha256,source:Object.freeze({...released.source}),
    trustedRoots:Object.freeze(released.trustedRoots.map(root=>new Uint8Array(root))),policyPins:new Uint8Array(released.policyPins),
  });
  const platform=declaration.manifest.platform === "native" ? "native" as const : undefined;
  const environment=selectAppEnvironment({environment:declaration.environment,appOrigin:declaration.origin,platform,release});
  const host={origin:declaration.origin,platform,environment:declaration.environment,...(fetcher?{fetch:fetcher}:{})};
  const loadRuntime=applicationAssetLoader(packaged.runtime,host),loadSqlite=applicationAssetLoader(packaged.sqlite,host);
  const initialize=packaged.initializeSqlite;
  if(typeof initialize!=="function"||typeof handoff!=="function")throw new Error("SDK packaged native application assets unavailable");
  const sql:AppCollectionSqlOptions=Object.freeze({wasmSha256:packaged.sqlite.sha256,maxWasmBytes:packaged.sqlite.maxBytes,
    loadWasm:loadSqlite,initialize});
  const collection:AppWebCollectionAdapterOptions=Object.freeze({
    joinDatabaseName:declaration.storage.joinDatabaseName,
    setupJournal:Object.freeze({databaseName:declaration.storage.setupDatabaseName,applicationNamespace:declaration.storage.applicationNamespace,
      appOrigin:declaration.origin,cpOrigin:environment.cpOrigin}),
    sql,handoff,...(fetcher?{fetch:fetcher}:{}),allowLoopbackHttp:environment.allowLoopbackHttp,
  });
  return Object.freeze({release,environment,loadRuntime,collection});
}
