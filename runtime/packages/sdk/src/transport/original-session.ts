/** Original HeldGrant provenance travels with the connector's port, never a new store read. */
import type {FramePort} from "./port.js";
import type {StoredAppGrant} from "../app-grant/grant-store.js";
const originals=new WeakMap<object,StoredAppGrant>();
export function bindOriginalAppGrant(port:FramePort,grant:StoredAppGrant):void{originals.set(port,grant);}
export function inheritOriginalAppGrant(port:FramePort,session:object):void{const grant=originals.get(port);if(grant)originals.set(session,grant);}
export function originalAppGrant(session:object):StoredAppGrant|undefined{return originals.get(session);}
