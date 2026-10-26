import {selectAppEnvironment} from "../app-host/app-environment.js";
import {urlOrigin} from "../app-host/app-origin.js";
import {mdbaseError} from "../errors.js";
import type {ApplicationAsset} from "./asset-loader.js";
import type {PackagedApplicationNativeAssets} from "./native-assets.js";
import {appReleaseTrust} from "./packaged-trust.js";
import {applicationEnvironmentAllowed} from "./local-build.js";
import pins from "./asset-pins.json" with {type:"json"};

// Exact original source-qualified bytes; integrity pins are NOT separate
// signatures. The packaging build records their independent source identities.
const runtime = Object.freeze({sha256:pins.runtime.sha256,bytes:pins.runtime.bytes,maxBytes:pins.runtime.maxBytes});
const sqlite = Object.freeze({sha256:pins.sqlite.sha256,bytes:pins.sqlite.bytes,maxBytes:pins.sqlite.maxBytes});
const unavailable = () => mdbaseError("unavailable", "SDK packaged application assets unavailable", "application_packaged_assets_unavailable");

/** Private SDK selector, not an application configuration callback. UI and
 * Worker use the same ESM artifact anchor. Selection performs no IO, storage,
 * Worker construction, dynamic imports or WASM initialization. */
export function packagedApplicationAssets(environment:"lab"|"production"|"local",appOrigin:string,platform?:"native"):PackagedApplicationNativeAssets {
  if(!applicationEnvironmentAllowed(environment))throw unavailable();
  if(environment==="production")throw mdbaseError("unavailable", "production trust unavailable", "application_production_trust_unavailable");
  const release=appReleaseTrust();
  selectAppEnvironment({environment,appOrigin,platform,release});
  // Literal `new URL(<asset>, import.meta.url)` forms let a consumer bundler
  // (Vite/Rollup/webpack) emit and rewrite the native assets.
  let runtimeUrl:URL,sqliteUrl:URL;
  try {
    const module=new URL(import.meta.url);
    if(urlOrigin(module)!==appOrigin||module.username||module.password||module.search||module.hash)throw unavailable();
    runtimeUrl=new URL("../native/runtime-lab.wasm",import.meta.url);
    sqliteUrl=new URL("../native/sqlite3.wasm",import.meta.url);
    if(urlOrigin(runtimeUrl)!==appOrigin||urlOrigin(sqliteUrl)!==appOrigin)throw unavailable();
  } catch { throw unavailable(); }
  const descriptor=(url:URL,pin:Pick<ApplicationAsset,"sha256"|"bytes"|"maxBytes">):ApplicationAsset=>Object.freeze({url:url.href,...pin});
  const initializeSqlite:PackagedApplicationNativeAssets["initializeSqlite"]=async options=>{
    const WorkerScope=(globalThis as typeof globalThis & {WorkerGlobalScope?:new()=>object}).WorkerGlobalScope;
    if(typeof WorkerScope!=="function"||!(globalThis instanceof WorkerScope))throw unavailable();
    // The official pinned browser initializer is loaded only inside SDK Worker,
    // after createAppCollectionSql has authenticated the supplied WASM bytes.
    // It is an emitted asset loaded by URL, never followed by a bundler: its
    // unused promiser default Worker script is not shipped.
    const initializer=new URL("../native/sqlite3.js",import.meta.url);
    const {default:initialize}=await import(/* @vite-ignore */ /* webpackIgnore: true */ initializer.href) as typeof import("../native/sqlite3.js");
    // Collection SQL explicitly uses SAH-pool. Skip the two unused VFSes
    // which otherwise probe an async proxy Worker that this SDK does not ship.
    // The pinned initializer consumes/deletes this bootstrap configuration;
    // leave opfs-sahpool enabled and keep the official asset bytes unchanged.
    (globalThis as typeof globalThis & {sqlite3ApiConfig?:unknown}).sqlite3ApiConfig={disable:{vfs:{opfs:true,"opfs-wl":true}}};
    return initialize(options);
  };
  return Object.freeze({release:()=>appReleaseTrust(),runtime:descriptor(runtimeUrl,runtime),sqlite:descriptor(sqliteUrl,sqlite),initializeSqlite});
}
