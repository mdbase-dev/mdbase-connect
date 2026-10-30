import {type AppWebSignInPortal} from "../app-host/web-sign-in-session.js";
import {AppScopedSignInSession} from "../app-host/scoped-sign-in-session.js";
import {createAppWebCollectionAdapter,type AppWebCollectionHandoff,type AppWebNativeCollection} from "../app-host/web-collection.js";
import type {AppLockPort} from "../app-host/owner.js";
import {applicationStorageOwner} from "./storage-scope.js";
import {applicationDeclaration,type ApplicationDeclarationSnapshot} from "./declaration.js";
import {compileApplicationManifest} from "./manifest.js";
import {applicationNativeAssets,type PackagedApplicationNativeAssets} from "./native-assets.js";

/** SDK Worker-internal ports. These are never application constructor options;
 * portal navigation/handoffs go to the SAME original SDK UI owner. */
export interface ApplicationWorkerSessionHost {
  readonly signal:AbortSignal;
  /** Captured before CP rebinding; null preserves the original default owner. */
  readonly storageNamespace:string|null;
  readonly locks:AppLockPort|undefined;
  openPortal():AppWebSignInPortal;
  handoff(value:AppWebCollectionHandoff):void;
  readonly fetch?:typeof fetch;
}
/** Compose the existing protected sign-in/native/SQL/journal implementations.
 * Scoped recovery routes to a separate original protected sign-in/native actor;
 * no new credential store, signer, engine or UI data client. */
export function applicationWorkerSession(
  declaration:Readonly<ApplicationDeclarationSnapshot>,
  packaged:PackagedApplicationNativeAssets,
  host:ApplicationWorkerSessionHost,
){
  const signal=host.signal,locks=host.locks,portal=host.openPortal,handoff=host.handoff,fetcher=host.fetch;
  signal.throwIfAborted();
  // Worker structured clone does not preserve the UI snapshot's freezing.
  const binding=applicationDeclaration(declaration);
  const compiled=compileApplicationManifest(binding);
  const assets=applicationNativeAssets(binding,packaged,handoff,fetcher);
  signal.throwIfAborted();
  // Sharing is part of launch approval, not an opt-out inferred from optional
  // declaration metadata. Availability never bypasses the original CP authority.
  const storageNamespace=host.storageNamespace;
  const collection=Object.freeze({...assets.collection,people:true});
  const session=new AppScopedSignInSession<AppWebNativeCollection>({
    // The CP assigns appId; the local slot owner is the declaration's own family.
    origin:binding.origin,appId:binding.id,owner:applicationStorageOwner(compiled.manifest.id,storageNamespace),...(storageNamespace===null?{}:{storageNamespace}),appName:binding.name,installationKind:binding.installationKind,
    cpOrigin:assets.environment.cpOrigin,environment:binding.environment,
    release:assets.release,signal,locks,loadRuntime:assets.loadRuntime,
    openPortal:portal,openCollection:createAppWebCollectionAdapter(collection),
    autoSelect:"never",localDatabases:Object.freeze([collection.joinDatabaseName,collection.setupJournal.databaseName]),...(fetcher?{fetch:fetcher}:{}),allowLoopbackHttp:assets.environment.allowLoopbackHttp,allowNativeLoopbackHttp:assets.environment.allowNativeLoopbackHttp,
    // Omit requestedCreateCollections: ORIGINAL stored request terms must not
    // be silently rewritten during restore. A fresh installation asks to create
    // collections so first-run approval can offer "New collection…" (a new
    // account has none to pick); the user still decides in Connect.
    freshRequestedCreateCollections:true,
  });
  return Object.freeze({session,compiled,collection});
}
