import type {ClientOptions} from "../client.js";
import type {AppWebCollectionHandoff} from "../app-host/web-collection.js";
import type {MdbaseApplicationConnection,MdbaseApplicationReadinessSnapshot,MdbaseApplicationRequestOptions} from "./entry.js";
import type {compileApplicationManifest} from "./manifest.js";
import {ApplicationUiConnections,ApplicationUiConnectionError} from "./ui-connections.js";
import {ApplicationReadiness,type ApplicationReadinessFacetSource} from "./readiness.js";
import {createApplicationConfiguration} from "./configuration.js";
import {createApplicationPeopleReadiness} from "./people-readiness.js";
import {createApplicationNotificationReadiness} from "./notification-readiness.js";
import {declaredTimerCriteria} from "./timer-criteria.js";
import type {MdbaseSetupPlan,MdbaseSetupPlanOptions} from "./setup.js";
import {bindFileAccess,type FileAction} from "../files.js";
import {fileAccessDeclaration,fileAccessGate} from "./file-access.js";
import {createApplicationFileReadiness} from "./file-readiness.js";

/** SDK-private selected scope composition. All borrowed facets share the original
 * UI client/control/journal; neither this owner nor its inputs create a native
 * host, SQL/key store, Worker, grant or replacement engine. */
interface Selected {
  readonly connection:MdbaseApplicationConnection;readonly lifetime:AbortController;
  readonly readiness:ApplicationReadiness;
  readonly configuration:ReturnType<typeof createApplicationConfiguration>;
  readonly unsubscribe:()=>void;
}
export class ApplicationScope {
  private readonly ui:ApplicationUiConnections;private readonly signal:AbortSignal;
  private readonly compiled:ReturnType<typeof compileApplicationManifest>;
  private readonly listeners=new Set<()=>void>();private selected:Selected|null=null;
  private epoch=0;private opening:Promise<MdbaseApplicationConnection>|null=null;
  private retiring:Promise<void>|null=null;private closing:Promise<void>|null=null;
  constructor(compiled:ReturnType<typeof compileApplicationManifest>,app:ClientOptions["app"],signal:AbortSignal,private readonly typeIssues:"block"|"degrade"="block",
    private readonly consented:(collectionId:string)=>readonly FileAction[]=()=>[]){
    // Private UI owner consumes the entry's frozen canonical projection. A
    // registered ID/name/storage rebind cannot alter its manifest/environment.
    // Worker structured-clone intake still validates independently in its realm.
    this.compiled=compiled;this.signal=signal;
    this.ui=new ApplicationUiConnections(app,signal,declaredTimerCriteria(this.compiled.manifest.notifications));
    signal.addEventListener("abort",this.abort,{once:true});
  }
  private readonly changed=()=>{for(const listener of [...this.listeners])try{listener();}catch{/* UI observers cannot alter custody */}};
  private readonly abort=()=>{void this.close().catch(()=>{});};
  subscribe(listener:()=>void):()=>void{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  connection(id:string):MdbaseApplicationConnection|null{return this.ui.connection(id);}
  getReadiness():MdbaseApplicationReadinessSnapshot|null{return this.selected?.readiness.getSnapshot()??null;}
  /** The open collection this tab holds, or null. */
  selectedId():string|null{return this.selected?.connection.id??null;}
  adopt(handoff:AppWebCollectionHandoff,caller:AbortSignal,isCurrent:()=>boolean):Promise<MdbaseApplicationConnection>{
    const epoch=this.epoch;
    const valid=()=>!this.signal.aborted&&!this.closing&&!this.retiring&&this.epoch===epoch&&isCurrent();
    // Even rejected overlapping/late transfers pass through the once-only port
    // owner so newly received ports are retired without touching an old scope.
    const occupied=!!this.opening||!!this.selected||!!this.retiring||!!this.closing;
    const adoption=this.ui.adopt(handoff,{caller,isCurrent:valid});
    if(occupied)return adoption;
    let constructing:AbortController|null=null;
    const cleanup:Array<()=>void|Promise<void>>=[];
    const pending=adoption.then(connection=>{
      if(!valid()||caller.aborted)throw new ApplicationUiConnectionError("application_connection_fenced");
      const helper=this.ui.owned();if(!helper)throw new ApplicationUiConnectionError("application_connection_binding");
      // Optional file actions follow the person's recorded choice (advisory on
      // an installation device: the replica does not narrow its own Host).
      const files=fileAccessDeclaration(this.compiled);
      if(files)bindFileAccess(connection.files,fileAccessGate(files,()=>this.consented(connection.id)));
      const lifetime=new AbortController(),signal=AbortSignal.any([this.signal,lifetime.signal]);constructing=lifetime;
      const current=()=>valid()&&connection.isCurrent();
      const binding={scope:connection.scope,generation:connection.generation,signal,isCurrent:current};
      const configuration=createApplicationConfiguration({client:connection.records,compiledManifest:this.compiled,journal:helper.journal,...binding,setupMode:helper.setupMode},helper.resourceSetup);
      cleanup.push(()=>configuration.close());
      const configurationSource:ApplicationReadinessFacetSource={getSnapshot:configuration.getSnapshot,subscribe:configuration.subscribe,refresh:configuration.assess,close:configuration.close};
      const people=createApplicationPeopleReadiness({people:connection.people,...binding});
      cleanup.push(()=>people.close());
      // The canonical parser normalizes `notifications: null` to no criteria; that
      // is the validated "no notification requirement" the facet reads as null.
      const declared=this.compiled.manifest.notifications;
      const notifications=createApplicationNotificationReadiness({notifications:{declaration:declared?.criteria?.length?declared:null},timers:connection.timers,...binding});
      cleanup.push(()=>notifications.close());
      const fileScope=(this.compiled.manifest.requirements.files as {readonly scope?:{readonly kind?:unknown}}|undefined)?.scope?.kind;
      const fileReadiness=createApplicationFileReadiness({declaration:files,scope:typeof fileScope==="string"?fileScope:null,grant:()=>connection.files.grant,isCurrent:current});
      cleanup.push(()=>fileReadiness.close());
      const nativeRequirements=this.compiled.nativeCapabilities?{...this.compiled.nativeCapabilities,contracts:this.compiled.manifest.requirements.contracts,typeIssues:this.typeIssues}:null;
      const readiness=new ApplicationReadiness({connection,nativeRequirements,signal,isCurrent:current,configuration:configurationSource,files:fileReadiness,people,notifications});
      const unsubscribe=readiness.subscribe(this.changed);
      this.selected={connection,lifetime,readiness,configuration,unsubscribe};constructing=null;cleanup.length=0;this.changed();return connection;
    }).catch(async error=>{
      constructing?.abort();
      const retired=await Promise.allSettled([this.ui.retire(),...cleanup.map(close=>Promise.resolve().then(close))]);
      const failed=retired.find(result=>result.status==="rejected");if(failed?.status==="rejected")throw failed.reason;throw error;
    }).finally(()=>{if(this.opening===pending)this.opening=null;});
    this.opening=pending;return pending;
  }
  assess(options:MdbaseApplicationRequestOptions={}):Promise<MdbaseApplicationReadinessSnapshot>{
    if(!this.selected||!this.selected.connection.isCurrent()||this.retiring||this.closing)return Promise.reject(new ApplicationUiConnectionError("application_connection_fenced"));
    return this.selected.readiness.refresh(options);
  }
  async configure(options:MdbaseApplicationRequestOptions={}):Promise<MdbaseApplicationReadinessSnapshot>{
    const original=this.selected,epoch=this.epoch;
    if(!original||!original.connection.isCurrent()||this.retiring||this.closing)throw new ApplicationUiConnectionError("application_connection_fenced");
    await original.configuration.configure(options);
    if(options.signal?.aborted||this.epoch!==epoch||this.selected!==original||!original.connection.isCurrent())throw new ApplicationUiConnectionError("application_connection_fenced");
    return original.readiness.refresh(options);
  }
  planSetup(options:MdbaseSetupPlanOptions={}):Promise<MdbaseSetupPlan>{
    const original=this.selected;
    if(!original||!original.connection.isCurrent()||this.retiring||this.closing)return Promise.reject(new ApplicationUiConnectionError("application_connection_fenced"));
    return original.configuration.plan(options);
  }
  async applySetup(plan:MdbaseSetupPlan,options:MdbaseApplicationRequestOptions={}):Promise<MdbaseApplicationReadinessSnapshot>{
    const original=this.selected,epoch=this.epoch;
    if(!original||!original.connection.isCurrent()||this.retiring||this.closing)throw new ApplicationUiConnectionError("application_connection_fenced");
    await original.configuration.apply(plan,options);
    if(options.signal?.aborted||this.epoch!==epoch||this.selected!==original||!original.connection.isCurrent())throw new ApplicationUiConnectionError("application_connection_fenced");
    return original.readiness.refresh(options);
  }
  retire():Promise<void>{
    if(this.retiring)return this.retiring;
    ++this.epoch;const original=this.selected,opening=this.opening;
    original?.lifetime.abort();original?.unsubscribe();
    // Begin original UI close before awaiting READ/helper drains. Otherwise a
    // held borrowed CONTROL reply could prevent its own port retirement.
    const ui=this.ui.retire();
    const retired=Promise.resolve().then(async()=>{
      const results=await Promise.allSettled([ui,opening?.catch(()=>{}),original?.readiness.close()]);
      const failed=results.find(result=>result.status==="rejected");if(failed?.status==="rejected")throw failed.reason;
      if(this.selected===original)this.selected=null;
    });
    this.retiring=retired;this.changed();
    void retired.then(()=>{if(this.retiring===retired)this.retiring=null;this.changed();},()=>{/* failed original drain retained/quarantined */});return retired;
  }
  close():Promise<void>{
    if(this.closing)return this.closing;
    this.signal.removeEventListener("abort",this.abort);
    this.closing=Promise.resolve().then(async()=>{await this.retire();await this.ui.close();this.listeners.clear();});return this.closing;
  }
}
