import {AppWebSignInSession,type AppWebSignInPortal} from "../app-host/web-sign-in-session.js";
import {createAppWebCollectionAdapter,type AppWebCollectionHandoff,type AppWebNativeCollection} from "../app-host/web-collection.js";
import type {AppLockPort} from "../app-host/owner.js";
import {applicationDeclaration,type ApplicationDeclarationSnapshot} from "./declaration.js";
import {compileApplicationManifest} from "./manifest.js";
import {applicationNativeAssets,type PackagedApplicationNativeAssets} from "./native-assets.js";

/** SDK Worker-internal ports. These are never application constructor options;
 * portal navigation/handoffs go to the SAME original SDK UI owner. */
export interface ApplicationWorkerSessionHost {
  readonly signal:AbortSignal;
  readonly locks:AppLockPort|undefined;
  openPortal():AppWebSignInPortal;
  handoff(value:AppWebCollectionHandoff):void;
  readonly fetch?:typeof fetch;
}
/** Compose the existing protected sign-in/native/SQL/journal implementations.
 * No new identity store, recovery policy, signer, engine or UI data client. */
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
  const collection=Object.freeze({...assets.collection,people:true});
  const session=new AppWebSignInSession<AppWebNativeCollection>({
    origin:binding.origin,appId:binding.id,appName:binding.name,
    cpOrigin:assets.environment.cpOrigin,environment:binding.environment,
    release:assets.release,signal,locks,loadRuntime:assets.loadRuntime,
    openPortal:portal,openCollection:createAppWebCollectionAdapter(collection),
    autoSelect:"never",...(fetcher?{fetch:fetcher}:{}),allowLoopbackHttp:assets.environment.allowLoopbackHttp,
    // Omit requestedCreateCollections: ORIGINAL stored request terms must not
    // be silently rewritten during restore. Fresh creation policy is separate.
  });
  return Object.freeze({session,compiled,collection});
}
