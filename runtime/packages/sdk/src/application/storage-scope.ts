import {sha256} from "@noble/hashes/sha2.js";
import type {ApplicationDeclarationSnapshot} from "./declaration.js";

/** Local organization only: same-origin JavaScript remains trusted. Compare
 * BEFORE registration rebinding so a replacement app ID cannot move old data. */
export function applicationStorageNamespace(declaration:Readonly<ApplicationDeclarationSnapshot>):string|null {
  return declaration.storage.applicationNamespace===declaration.id?null:declaration.storage.applicationNamespace;
}
export function storageNamespaceDigest(namespace:string):string {
  return Array.from(sha256(new TextEncoder().encode(namespace)),byte=>byte.toString(16).padStart(2,"0")).join("");
}
/** Bounded owner also leaves room for the existing :scope:<UUID> recovery slot.
 * Hash the tuple to avoid delimiter collisions and preserve the family binding. */
export function applicationStorageOwner(manifestId:string,namespace:string|null):string {
  return namespace===null?`bundle:${manifestId}`:`bundle-storage:${storageNamespaceDigest(JSON.stringify([manifestId,namespace]))}`;
}
