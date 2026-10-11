import {applicationWorkerSession} from "./worker-session.js";
import type {ApplicationDeclarationSnapshot} from "./declaration.js";
import type {PackagedApplicationNativeAssets} from "./native-assets.js";
import type {AppLockPort} from "../app-host/owner.js";
import type {AppWebCollectionHandoff} from "../app-host/web-collection.js";
import type {AppWebSignInPortal} from "../app-host/web-sign-in-session.js";
import {APPLICATION_WORKER_PROTOCOL,ApplicationWorkerError,applicationWorkerBinding,applicationWorkerProblem,applicationWorkerRequest,
  type ApplicationWorkerEvent,type ApplicationWorkerRequest} from "./worker-protocol.js";

/** SDK-private lifecycle owner, distinct from the existing native CONTROL
 * channel. No record RPC, queue, retry, authority loan or replacement client.
 * The public entry resolves registration before boot/start; constructing this
 * owner does not open a profile or initialize native/SQL. */
export class ApplicationWorkerHost {
  readonly session:ReturnType<typeof applicationWorkerSession>["session"];
  private readonly lifetime=new AbortController();
  private readonly port:MessagePort;
  private readonly binding:string;
  private lastId=0;
  private active:ApplicationWorkerRequest|null=null;
  private pending:Promise<void>|null=null;
  private stopping:Promise<void>|null=null;
  private foreground=true;
  private appliedForeground:string|null=null;
  private unsubscribe:(()=>void)|null=null;
  constructor(port:MessagePort,binding:string,declaration:Readonly<ApplicationDeclarationSnapshot>,packaged:PackagedApplicationNativeAssets,locks:AppLockPort|undefined,fetcher?:typeof fetch){
    if(!applicationWorkerBinding(binding))throw new ApplicationWorkerError("application_worker_binding");
    this.port=port;this.binding=binding;
    const composed=applicationWorkerSession(declaration,packaged,{signal:this.lifetime.signal,locks,
      openPortal:()=>this.portal(),handoff:value=>this.handoff(value),...(fetcher?{fetch:fetcher}:{})});
    this.session=composed.session;
    this.unsubscribe=this.session.subscribe(()=>{this.applyForeground();if(!this.stopping)this.post([APPLICATION_WORKER_PROTOCOL,this.binding,"nativeSnapshot",0,this.session.getSnapshot()]);});
    this.port.addEventListener("message",this.onMessage);this.port.addEventListener("messageerror",this.onMessageError);this.port.start();
    this.post([APPLICATION_WORKER_PROTOCOL,this.binding,"nativeSnapshot",0,this.session.getSnapshot()]);
  }
  private post(value:ApplicationWorkerEvent,transfer:Transferable[]=[]):void {
    try{this.port.postMessage(value,transfer);}catch{
      // Delivery failure is not permission to drop ownership or unlock SQL.
      void this.stop().catch(()=>{});throw new ApplicationWorkerError("application_worker_unavailable");
    }
  }
  private portal():AppWebSignInPortal {
    const owner=this.active;
    if(!owner||!["authorize","renewExpiredPairing"].includes(owner[3])||this.stopping)throw new ApplicationWorkerError("application_worker_fenced");
    let closed=false;
    return Object.freeze({navigate:(uri:string)=>{
      if(closed||this.stopping||this.lifetime.signal.aborted)throw new ApplicationWorkerError("application_worker_fenced");
      this.post([APPLICATION_WORKER_PROTOCOL,this.binding,"portal",owner[2],{action:"navigate",uri}]);
    },close:()=>{if(closed)return;closed=true;this.post([APPLICATION_WORKER_PROTOCOL,this.binding,"portal",owner[2],{action:"close"}]);}});
  }
  private handoff(value:AppWebCollectionHandoff):void {
    const owner=this.active;
    if(!owner||this.stopping||this.lifetime.signal.aborted)throw new ApplicationWorkerError("application_worker_fenced");
    // Transfer ALL original present ports. Native adapter owns cleanup if the
    // delivery throws; never keep/reconstruct a second facade/engine.
    this.post([APPLICATION_WORKER_PROTOCOL,this.binding,"handoff",owner[2],value],[value.dataPort,value.controlPort,...(value.timerPort?[value.timerPort]:[])]);
  }
  private applyForeground():void {
    if(this.stopping)return;
    const connection=this.session.connection();
    if(!connection?.isCurrent())return;
    const key=`${connection.generation}:${this.foreground}`;
    if(this.appliedForeground===key)return;
    connection.setForeground(this.foreground);this.appliedForeground=key;
  }
  private failStop(code:"application_worker_binding"|"application_worker_unavailable"):void {
    try{this.post([APPLICATION_WORKER_PROTOCOL,this.binding,"fatal",0,{code}]);}catch{/* original stop owns delivery failure */}
    void this.stop().catch(()=>{});
  }
  private readonly onMessageError=()=>{this.failStop("application_worker_unavailable");};
  private readonly onMessage=(event:MessageEvent<unknown>)=>{
    let request:ApplicationWorkerRequest;
    try{
      request=applicationWorkerRequest(event.data,this.binding);
      if(request[2]===0){
        // Visibility never waits behind sign-in/receipt IO and does not acquire
        // a second operation/metadata slot. No queue or acknowledgement RPC.
        if(!this.stopping){this.foreground=request[4] as boolean;this.session.setForeground(this.foreground);this.applyForeground();}
        return;
      }
      if(request[2]<=this.lastId)throw new ApplicationWorkerError("application_worker_binding");
      this.lastId=request[2];
    }catch{this.failStop("application_worker_binding");return;}
    if(request[3]==="close"){
      // Closing interrupts lifetime but drains the ORIGINAL operation. It is
      // the only terminal cut allowed while the sole request slot is occupied.
      void this.stop(false).then(()=>{
        try{this.post([APPLICATION_WORKER_PROTOCOL,this.binding,"reply",request[2],{ok:true,snapshot:this.session.getSnapshot()}]);}finally{this.detach();}
      },()=>{try{this.post([APPLICATION_WORKER_PROTOCOL,this.binding,"reply",request[2],{ok:false,problem:{code:"application_worker_stop_failed"}}]);}catch{/* ownership remains quarantined */}}).catch(()=>{});
      return;
    }
    if(this.stopping||this.pending){
      try{this.post([APPLICATION_WORKER_PROTOCOL,this.binding,"reply",request[2],{ok:false,problem:{code:this.stopping?"application_worker_fenced":"application_worker_busy"}}]);}catch{/* stop already owns cleanup */}return;
    }
    this.active=request;
    const pending=Promise.resolve().then(()=>this.invoke(request)).then(()=>{
      if(this.stopping||this.lifetime.signal.aborted)throw new ApplicationWorkerError("application_worker_fenced");
      this.post([APPLICATION_WORKER_PROTOCOL,this.binding,"reply",request[2],{ok:true,snapshot:this.session.getSnapshot()}]);
    }).catch(error=>{
      try{this.post([APPLICATION_WORKER_PROTOCOL,this.binding,"reply",request[2],{ok:false,problem:applicationWorkerProblem(error)}]);}catch{/* stop owns late delivery */}
    }).finally(()=>{if(this.pending===pending){this.pending=null;this.active=null;}});
    this.pending=pending;
  };
  private async invoke(request:ApplicationWorkerRequest):Promise<void>{
    if(this.stopping||this.lifetime.signal.aborted)throw new ApplicationWorkerError("application_worker_fenced");
    const payload=request[4];
    switch(request[3]){
      case "start":await this.session.start();break;
      case "authorize":await this.session.authorize({collectionHint:payload as string|null});break;
      case "renewExpiredPairing":await this.session.renewExpiredPairing();break;
      case "select":await this.session.select(payload as string);break;
      case "clearSelection":await this.session.clearSelection();break;
      case "forget":await this.session.forget(payload as string);break;
      case "foreground":this.foreground=payload as boolean;this.session.setForeground(this.foreground);this.applyForeground();break;
      case "close":throw new ApplicationWorkerError("application_worker_fenced");
    }
  }
  /** Once-only physical stop. Failed native/SQL stop retains this owner, port and
   * original SDK leases; a subsequent call returns the SAME rejection. */
  stop(detach=true):Promise<void>{
    if(this.stopping)return this.stopping;
    const pending=this.pending;
    this.stopping=Promise.resolve().then(async()=>{
      await this.session.close();await pending;
      this.unsubscribe?.();this.unsubscribe=null;
      if(detach)this.detach();
    });
    this.lifetime.abort();return this.stopping;
  }
  private detach():void {
    this.port.removeEventListener("message",this.onMessage);this.port.removeEventListener("messageerror",this.onMessageError);this.port.close();
  }
}
