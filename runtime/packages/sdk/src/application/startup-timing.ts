import type {MdbasePhase} from "./phase.js";

const PREFIX="mdbase:startup:";
/** Phases that wait for the person: automatic startup ends there. */
const WAITS:ReadonlySet<MdbasePhase["kind"]>=new Set(["signed_out","authorizing","choosing","needs_approval","needs_setup","problem","unavailable","closed"]);
type Clock=Pick<Performance,"now"|"measure">;
function clock():Clock|null{
  const value=(globalThis as {performance?:Partial<Clock>}).performance;
  return typeof value?.now==="function"&&typeof value.measure==="function"?value as Clock:null;
}

/** Browser-local User Timing measures named `mdbase:startup:<stage>`, from the
 * entry's construction until a collection is first usable or the person is
 * asked for something. Stages are fixed labels: no account, collection, grant
 * or error data. Diagnostic only; timing never changes an outcome. */
export class ApplicationStartupTiming {
  private readonly clock=clock();
  private readonly began=this.clock?.now()??0;
  private stage:string|null=null;
  private since=this.began;
  private done=this.clock===null;
  private measure(stage:string,start:number,end:number):void{
    try{this.clock?.measure(`${PREFIX}${stage}`,{start,end});}catch{/* diagnostics only */}
  }
  /** One awaited startup step (registration, the session's start, ...). A step
   * begun during startup is measured even when the phase that ends startup is
   * seen first: opening work before connecting settles after its phase shows. */
  async time<T>(stage:"capabilities"|"registration"|"election"|"session"|"unsynced",operation:()=>Promise<T>):Promise<T>{
    if(this.done)return operation();
    const start=this.clock!.now();
    try{return await operation();}finally{this.measure(stage,start,this.clock!.now());}
  }
  /** The phase the application shows now: one measure per phase passed
   * through (`opening:<progress>` while a collection opens), then `total`. */
  observe(phase:MdbasePhase):void{
    if(this.done)return;
    const stage=phase.kind==="opening"&&phase.progress?`opening:${phase.progress}`:phase.kind;
    if(stage===this.stage)return;
    const now=this.clock!.now();
    if(this.stage!==null)this.measure(this.stage,this.since,now);
    this.stage=stage;this.since=now;
    const usable=phase.kind==="ready"||phase.kind==="unsynced";
    if(usable)this.measure("total",this.began,now);
    if(usable||WAITS.has(phase.kind))this.done=true;
  }
}
