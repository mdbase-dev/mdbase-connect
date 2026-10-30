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
  // Preserve Worker error delivery if the failed-bootstrap port itself refuses
  // its fatal response. No native owner has been installed in that case.
  void initialize(event).catch(error=>{queueMicrotask(()=>{throw error;});});
}
async function initialize(event:MessageEvent<unknown>):Promise<void> {
  const port=event.ports[0],value=event.data;
  let binding:string|null=null;
  try{
    if(!port||event.ports.length!==1||!Array.isArray(value)||(value.length!==3&&value.length!==4)||value[0]!==APPLICATION_WORKER_PROTOCOL||!applicationWorkerBinding(value[1]))throw new ApplicationWorkerError("application_worker_binding");
    binding=value[1];
    const declaration=applicationDeclaration(value[2]);
    const storageNamespace=value.length===4?value[3]:null;
    if(storageNamespace!==null&&(typeof storageNamespace!=="string"||storageNamespace!==declaration.storage.applicationNamespace))throw new ApplicationWorkerError("application_worker_binding");
    if(declaration.origin!==currentAppOrigin())throw new ApplicationWorkerError("application_worker_binding");
    const packaged=packagedApplicationAssets(declaration.environment,declaration.origin,declaration.manifest.platform === "native" ? "native" : undefined);
    // All startup requests remain queued on the SAME unstarted MessagePort.
    // No profile, journal, key or native actor exists until this original
    // bootstrap has validated its immutable declaration and asset selection.
    // The host is imported statically: apps re-bundle this Worker, and a
    // default Vite consumer (iife workers) cannot code-split it.
    owner=new ApplicationWorkerHost(port,binding,declaration,packaged,globalThis.navigator.locks,storageNamespace);
    const primary=binding;
    // The leader page attaches follower tabs (each on its own port) and detaches
    // them when they leave. Only the page that created this Worker can post here.
    globalThis.addEventListener("message",(message:MessageEvent<unknown>)=>{
      const data=message.data;
      if(!owner||!Array.isArray(data)||data.length!==4||data[0]!==APPLICATION_WORKER_PROTOCOL||data[1]!==primary||!applicationWorkerBinding(data[3])){for(const input of message.ports)input.close();return;}
      if(data[2]==="attach"&&message.ports.length===1)owner.attach(message.ports[0]!,data[3]);
      else if(data[2]==="detach"&&message.ports.length===0)owner.detachClient(data[3]);
      else for(const input of message.ports)input.close();
    });
  }catch(error){
    // No startup operation was accepted, so no profile/native/SQL was opened.
    try{if(port&&binding)port.postMessage([APPLICATION_WORKER_PROTOCOL,binding,"fatal",0,applicationWorkerProblem(error)]);}finally{for(const input of event.ports)input.close();}
  }
}
globalThis.addEventListener("message",bootstrap);
// Keep the once-owned session reachable for the lifetime of this Worker,
// including a memoized failed physical stop and its quarantined leases.
void owner;
