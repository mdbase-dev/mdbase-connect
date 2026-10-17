import type {AppLockPort, AppLockWaitPort} from "../../src/app-host/owner.js";

/** Exclusive ifAvailable owners and shared waiters; no timers or storage mocks. */
export function signInLocks() {
  const held=new Set<string>(), waiting=new Map<string, (()=>void)[]>(), names:string[]=[], events:{kind:"grant"|"release";name:string}[]=[];
  const port:AppLockPort & AppLockWaitPort={request:(async(name:string,options:{mode:string;signal?:AbortSignal},callback:(lock:object|null)=>Promise<void>)=>{
    names.push(`${options.mode}:${name}`);
    if(options.signal?.aborted)throw options.signal.reason;
    if(options.mode==="exclusive") {
      if(held.has(name))return callback(null);
      held.add(name);events.push({kind:"grant",name});
      try {await callback({});} finally {
        held.delete(name);events.push({kind:"release",name});
        const queue=waiting.get(name)??[];waiting.delete(name);queue.forEach(run=>run());
      }
      return;
    }
    if(held.has(name))await new Promise<void>((resolve,reject)=>{
      const done=()=>{options.signal?.removeEventListener("abort",abort);resolve();};
      const abort=()=>{waiting.set(name,(waiting.get(name)??[]).filter(run=>run!==done));reject(options.signal!.reason);};
      options.signal?.addEventListener("abort",abort,{once:true});
      waiting.set(name,[...(waiting.get(name)??[]),done]);
    });
    await callback({});
  }) as never};
  return {port,names,waiting,held,events};
}
