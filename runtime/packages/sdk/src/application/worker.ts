/** SDK-owned ESM Worker. No application-provided loader/SQL/authority callback.
 * Initialization composes only; the public entry must resolve the registered
 * declaration before boot/start and own the corresponding UI ports/client. */
import {currentAppOrigin} from "../app-host/app-origin.js";
import {applicationDeclaration} from "./declaration.js";
import {packagedApplicationAssets} from "./packaged-assets.js";
import {ApplicationWorkerHost} from "./worker-host.js";
import {APPLICATION_WORKER_PROTOCOL,ApplicationWorkerError,applicationWorkerBinding,applicationWorkerProblem} from "./worker-protocol.js";

const WorkerScope=(globalThis as typeof globalThis&{WorkerGlobalScope?:new()=>object}).WorkerGlobalScope;
if(typeof WorkerScope!=="function"||!(globalThis instanceof WorkerScope))throw new ApplicationWorkerError("application_worker_unavailable");
let owner:ApplicationWorkerHost|null=null;
function bootstrap(event:MessageEvent<unknown>):void {
  globalThis.removeEventListener("message",bootstrap);
  const port=event.ports[0],value=event.data;
  let binding:string|null=null;
  try{
    if(!port||event.ports.length!==1||!Array.isArray(value)||value.length!==3||value[0]!==APPLICATION_WORKER_PROTOCOL||!applicationWorkerBinding(value[1]))throw new ApplicationWorkerError("application_worker_binding");
    binding=value[1];
    const declaration=applicationDeclaration(value[2]);
    if(declaration.origin!==currentAppOrigin())throw new ApplicationWorkerError("application_worker_binding");
    const packaged=packagedApplicationAssets(declaration.environment,declaration.origin);
    owner=new ApplicationWorkerHost(port,binding,declaration,packaged,globalThis.navigator.locks);
  }catch(error){
    // No startup operation was accepted, so no profile/native/SQL was opened.
    try{if(port&&binding)port.postMessage([APPLICATION_WORKER_PROTOCOL,binding,"fatal",0,applicationWorkerProblem(error)]);}finally{for(const input of event.ports)input.close();}
  }
}
globalThis.addEventListener("message",bootstrap);
// Keep the once-owned session reachable for the lifetime of this Worker,
// including a memoized failed physical stop and its quarantined leases.
void owner;
