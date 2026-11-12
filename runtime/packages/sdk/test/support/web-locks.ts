import type {ApplicationTabLocks} from "../../src/application/tabs.js";

/** Exclusive Web Locks with ifAvailable, waiting and abort; one realm stands in for the browser. */
export function webLocks():ApplicationTabLocks{
  const held=new Set<string>(),queues=new Map<string,Array<()=>void>>();
  const next=(name:string)=>{const run=queues.get(name)?.shift();if(run)run();};
  const grant=(name:string,callback:(lock:unknown)=>Promise<void>|void)=>{held.add(name);
    return Promise.resolve().then(()=>callback({name})).finally(()=>{held.delete(name);next(name);});};
  return {request(name:string,options:{ifAvailable?:true;signal?:AbortSignal},callback:(lock:unknown)=>Promise<void>|void){
    if(options.ifAvailable)return held.has(name)||queues.get(name)?.length?Promise.resolve(callback(null)):grant(name,callback);
    if(!held.has(name))return grant(name,callback);
    return new Promise((resolve,reject)=>{
      const queue=queues.get(name)??[];queues.set(name,queue);
      const run=()=>{options.signal?.removeEventListener("abort",abort);grant(name,callback).then(resolve,reject);};
      const abort=()=>{queue.splice(queue.indexOf(run),1);reject(options.signal!.reason);};
      queue.push(run);options.signal?.addEventListener("abort",abort,{once:true});
    });
  }} as ApplicationTabLocks;
}
