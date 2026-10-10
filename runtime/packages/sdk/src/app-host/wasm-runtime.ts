/** Optional first-party app artifact binding. No auth/custody defaults or MemStore fallback. */
import { decode, encodeSecret, type CborValue } from "../cbor.js";
import { hashToBytes, uuidToBytes } from "../codec.js";
import { mdbaseError } from "../errors.js";
import { WasmRuntime, type Exports, type OpenConfig } from "../runtime/wasm.js";
import { confirmedHead, syncStatus, type ConfirmedHead, type SyncStatus } from "../wire.js";
import { AppLogPump, type AppLogCall, type AppLogRuntime, type AppLogTransport } from "./log-pump.js";
import type { AppLogHttpProof } from "./http-log.js";

export interface AppSqlMemory {
  memory: WebAssembly.Memory;
  alloc(length: number): number;
}
/** Bind the existing AppBinaryIndexHost/appSqlHost in the SAME Worker. */
export interface AppSqlLifetime {
  import(exports: () => AppSqlMemory): (ptr: number, len: number) => bigint;
  /** Fence the connection/clean marker on a trap or malformed ABI observation. */
  fence(): void;
  readonly needsRecovery: boolean;
}
/** Supplied ONLY by authenticated host selection after async protected key unwrap. */
export interface AppBootstrap {
  collection: string;
  replicaId: string;
  deviceId: string;
  endpoint: number | bigint;
  trustedRoots: readonly Uint8Array[];
  /** Canonical public PolicyPins from the shared BUILD-time signed environment
   * trust-asset verifier, bundled in the release. Never CP/log/UI-derived.
   * Native validates IDs/strong keys/root binding and warm consistency. */
  policyPins: Uint8Array;
  trustedSigners: readonly string[];
  expectedGenesis: string;
  state: "e2e" | "cloud_copy";
  cloudCopyOptIn: boolean;
  /** Owned transient buffers: openAppConsuming wipes both on ordinary return. */
  signSecretKey: Uint8Array;
  kemSecretKey: Uint8Array;
  opened: "fresh" | "existing" | "unclean";
  sqliteVersion: number;
}
/** Trusted authenticated host bootstrap only, never a grant/app RPC. */
export interface AppCpConnectorPin {
  readonly connectorId: string;
  readonly deviceId: string;
  readonly collection: string;
  isCurrent(): boolean;
}
/** Authenticating-host per-installation identity BEFORE any collection.
 * Dedicated connector/device, never application grant or daemon identity. */
export interface AppDeviceIdentityPin { readonly connectorId: string; readonly deviceId: string; readonly installationId: string; isCurrent(): boolean; }
export interface AppDeviceBootstrap {
  pin: AppDeviceIdentityPin;
  /** Protected transient loans, consumed/wiped; NEVER a Noise secret. */
  signSecretKey: Uint8Array; kemSecretKey: Uint8Array;
  opened: { mode: "fresh" } | { mode: "existing"; envelope: Uint8Array };
}
export type AppCollectionBootstrap = Omit<AppBootstrap,"signSecretKey" | "kemSecretKey">;
/** Actual authenticated registration response, or protected stored receipt for
 * offline reopen. Ciphertext possession is NOT registration completion. */
export interface AppDeviceRegistrationReceipt extends AppDevicePublicIdentity { readonly connectorId: string; readonly deviceId: string; readonly installationId: string; }
export interface AppDevicePublicIdentity { readonly signPublicKey: Uint8Array; readonly kemPublicKey: Uint8Array; readonly noisePublicKey: Uint8Array; }
export interface AppNoiseCustodyResult extends AppDevicePublicIdentity { readonly envelope: Uint8Array; }
export interface AppCpEnrolProof extends AppDevicePublicIdentity { readonly signature: Uint8Array; }
/** Authenticated host prospective collection decision, not a grant/readiness. */
export interface AppCloudCopyCollectionPin extends AppDeviceIdentityPin { readonly collection:string; readonly purpose:"create"|"join"; readonly approvalMode:"password-ak1"|"strict"; }
export interface AppPrivateCollectionPin extends AppDeviceIdentityPin { readonly collection: string; readonly purpose: "create" | "enrol"; readonly approvalMode: "password-ak1" | "strict"; }
export interface AppPrivateDeviceEnrolProof { readonly signature: Uint8Array; readonly sasCommitment: Uint8Array; }
/** PUBLIC exact-tuple operation marker, authenticated platform-protected.
 * r is NEVER stored. Acknowledgement is actual CP response, NOT approval/keyed. */
export interface AppPrivateEnrolOperationMarker extends AppDeviceRegistrationReceipt { readonly collection: string; readonly sasCommitment: Uint8Array; readonly acknowledged: boolean; }
export type AppPrivateCollectionOpen = { readonly mode: "fresh" } | { readonly mode: "existing"; readonly marker: AppPrivateEnrolOperationMarker };
export interface AppAccountKeyPin extends AppDeviceIdentityPin {readonly collection:string;readonly approvalMode:"password-ak1"|"strict";}
export type AppAccountKeyRefusal="not_private"|"not_ready"|"not_enrolled"|"not_authorized"|"device_missing"|"enrolment_mismatch"|"not_keyed"|"no_wrap"|"inconsistent"|"failed"|"outcome_unknown";
export type AppAccountKeyState={readonly state:"pending"|"keyed"}|{readonly state:"refused";readonly reason:AppAccountKeyRefusal};
export type AppAccountKeyDeviceSetupState={readonly state:"recovery_pending"|"recovery_keyed"}|{readonly state:"refused";readonly reason:AppAccountKeyRefusal};
export class AppStrictDeviceApprovalError extends Error {
  readonly reason = "strict_device_approval";
  constructor() { super("this account uses strict device approval; add this device from your desktop"); this.name = "AppStrictDeviceApprovalError"; }
}
/** Captured from the actual authenticated hosted session, not witness/hello
 * self-claims, NoisePK or guessed CP fields. No signing key supplied by JS. */
export interface AppHandoverSource {
  readonly collection: string;
  readonly deviceId: string;
  isCurrent(): boolean;
}
export interface AppRuntimeObservations {
  status: SyncStatus;
  keyringRebuilding: boolean;
  keyringRebuildFailed: boolean;
  snapshotInstallAvailable: boolean;
  requiresReopen: boolean;
}
interface SqlBinding { sql: AppSqlLifetime | null; exports: (() => AppSqlMemory) | null; run: ((p:number,n:number)=>bigint) | null; }
interface AppExports extends Exports {
  rt_app_device_open(p: number, n: number): bigint;
  rt_app_device_registered(p: number, n: number): number;
  rt_app_device_adopt(p: number, n: number): bigint;
  rt_app_device_retire(): void;
  rt_app_cp_enrol_sign(p: number, n: number): bigint;
  rt_app_cloud_copy_pin(p: number, n: number): number;
  rt_app_cloud_copy_create_sign(p: number, n: number): bigint;
  rt_app_cloud_copy_join_sign(p: number, n: number): bigint;
  rt_app_private_collection_pin(p: number, n: number): number;
  rt_app_private_enrol_commitment(): bigint;
  rt_app_private_enrol_restore(p: number, n: number): number;
  rt_app_private_create_sign(p: number, n: number): bigint;
  rt_app_private_device_enrol_sign(p: number, n: number): bigint;
  rt_app_verify_handover(session: bigint, dp: number, dn: number, wp: number, wn: number): bigint;
  rt_app_bases_execute?(session: bigint, p: number, n: number): bigint;
  rt_app_bases_list_views?(session: bigint, p: number, n: number): bigint;
  rt_app_bases_read_view_source?(session: bigint, p: number, n: number): bigint;
  rt_app_cp_bind_connector(p: number, n: number): number;
  rt_app_cp_log_token_sign(p: number, n: number): bigint;
  rt_app_open(p: number, n: number): bigint;
  rt_app_log_bind(endpoint: bigint, p: number, n: number): number;
  rt_app_log_generation(): bigint;
  rt_app_log_reconnect(endpoint:bigint,p:number,n:number):number;
  rt_app_log_http_sign(endpoint: bigint, generation: bigint, original: bigint, p: number, n: number): bigint;
  rt_app_log_calls(): bigint;
  rt_app_log_reply(id: bigint, p: number, n: number): number;
  rt_app_log_no_response(id: bigint): void;
  rt_app_log_retire(): void;
  rt_app_log_push(p: number, n: number): number;
  rt_app_observations(): bigint;
  rt_app_account_key_unlock(p:number,n:number):bigint;
  rt_app_account_key_status():bigint;
  rt_app_account_key_device_setup(p:number,n:number):bigint;
  rt_app_shutdown(): number;
}
const bad = () => mdbaseError("unavailable", "app runtime unavailable; reopen and reconcile");
function policyPins(v: Uint8Array): Uint8Array {
  if (!(v instanceof Uint8Array) || v.length === 0 || v.length > 64 * 1024) throw bad();
  return new Uint8Array(v);
}
function uint64(v: unknown): bigint {
  if ((typeof v !== "number" || !Number.isSafeInteger(v)) && typeof v !== "bigint") throw bad();
  const n = BigInt(v as number | bigint);
  if (n < 0n || n > (1n << 64n) - 1n) throw bad();
  return n;
}
const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length===b.length && a.every((v,i)=>v===b[i]);
function b32(v: Uint8Array): Uint8Array { if (!(v instanceof Uint8Array) || v.length !== 32) throw bad(); return v; }

/** One module/database lifetime. Call pump.close() before shutdown/SQL close;
 * terminate Worker before releasing its lease if drain/disposal fails. */
export class AppWasmRuntime extends WasmRuntime implements AppLogRuntime {
  private attempted = false;
  private active = false;
  private retired = false;
  private collection: string | null = null;
  private deviceId: string | null = null;
  private connectorId: string | null = null;
  private cpPin: AppCpConnectorPin | null = null;
  private deviceAttempted = false;
  private deviceActive = false;
  private deviceRegistered = false;
  private devicePin: AppDeviceIdentityPin | null = null;
  private installationId: string | null = null;
  private publicIdentity: AppDevicePublicIdentity | null = null;
  private noiseEnvelope: Uint8Array | null = null;
  private cloudSource:AppCloudCopyCollectionPin|null=null;
  private cloudCallback:AppCloudCopyCollectionPin["isCurrent"]|null=null;
  private cloudCollection:string|null=null;
  private cloudPurpose:"create"|"join"|null=null;
  private cloudIssued=false;
  private privateAttempted = false;
  private privateSource: AppPrivateCollectionPin | null = null;
  private prospectiveCollection: string | null = null;
  private privatePurpose: "create" | "enrol" | null = null;
  private sasCommitment: Uint8Array | null = null;
  private privateEnrolAcknowledged = false;
  private endpoint: bigint | null = null;
  private logGeneration = 0n;
  private pump: AppLogPump | null = null;
  private transport: AppLogTransport | null = null;
  private constructor(x: AppExports, private readonly sqlBinding: SqlBinding) { super(x); }
  private get sql(): AppSqlLifetime | null { return this.sqlBinding.sql; }
  private get app(): AppExports { return this.x as AppExports; }
  static async create(bytes: BufferSource, sql: AppSqlLifetime): Promise<AppWasmRuntime> {
    if (sql.needsRecovery) throw bad(); return this.instantiateApp(bytes,sql);
  }
  /** Device-only module with DENYING SQL import. Collection trust/database is
   * deliberately not required/created while registering a fresh installation. */
  static async createDevice(bytes: BufferSource): Promise<AppWasmRuntime> { return this.instantiateApp(bytes,null); }
  private static async instantiateApp(bytes:BufferSource,sql:AppSqlLifetime|null):Promise<AppWasmRuntime> {
    const binding:SqlBinding={sql,exports:null,run:null};
    const x=await this.load(bytes,exports=>{binding.exports=exports;binding.run=sql?.import(exports)??null;return {host_app_sql:(p:number,n:number)=>binding.run?.(p,n)??0n};});
    const names = ["rt_app_account_key_unlock", "rt_app_account_key_status", "rt_app_account_key_device_setup", "rt_app_private_collection_pin", "rt_app_private_enrol_restore", "rt_app_private_enrol_commitment", "rt_app_private_create_sign", "rt_app_private_device_enrol_sign", "rt_app_device_open", "rt_app_device_registered", "rt_app_device_adopt", "rt_app_device_retire", "rt_app_cp_enrol_sign", "rt_app_verify_handover", "rt_app_cp_bind_connector", "rt_app_cp_log_token_sign", "rt_app_open", "rt_app_log_bind", "rt_app_log_generation", "rt_app_log_reconnect", "rt_app_log_http_sign", "rt_app_log_calls", "rt_app_log_reply", "rt_app_log_no_response", "rt_app_log_retire", "rt_app_log_push", "rt_app_observations", "rt_app_shutdown"] as const;
    if (!(x.memory instanceof WebAssembly.Memory) || names.some(name => typeof (x as unknown as Record<string, unknown>)[name] !== "function")) throw bad();
    return new AppWasmRuntime(x as AppExports, binding);
  }
  /** The app artifact never uses a legacy/config-default MemStore path. */
  override open(_config: OpenConfig): never { throw bad(); }
  private fail(): void { try { if (this.active || this.attempted) this.sql?.fence(); } finally { this.active = false; this.deviceActive = false; this.discard(); } }
  private guard<T>(f: () => T): T {
    try { return f(); } catch { this.fail(); throw bad(); }
  }
  /** One attempt. The caller must unwrap keys before this SYNCHRONOUS operation. */
  openAppConsuming(c: AppBootstrap): void {
    let encoded: Uint8Array | null = null;
    try {
      if (this.attempted || this.deviceAttempted || !this.sql || this.sql.needsRecovery) throw bad();
      this.attempted = true;
      const endpoint = uint64(c.endpoint);
      if (!Array.isArray(c.trustedRoots) || c.trustedRoots.length < 1 || c.trustedRoots.length > 64 || !Array.isArray(c.trustedSigners) || c.trustedSigners.length > 1_024) throw bad();
      if (!Number.isSafeInteger(c.sqliteVersion) || c.sqliteVersion < 0 || c.sqliteVersion > 0xffff_ffff) throw bad();
      const state = c.state === "e2e" ? 0 : c.state === "cloud_copy" ? 1 : -1;
      const opened = c.opened === "fresh" ? 0 : c.opened === "existing" ? 1 : c.opened === "unclean" ? 2 : -1;
      if (state < 0 || opened < 0 || typeof c.cloudCopyOptIn !== "boolean" || (state === 1) !== c.cloudCopyOptIn) throw bad();
      encoded = encodeSecret(new Map<number, CborValue>([
        [0, 3], [1, uuidToBytes(c.collection)], [2, uuidToBytes(c.replicaId)], [3, uuidToBytes(c.deviceId)],
        [4, endpoint], [5, c.trustedRoots.map(b32)], [6, c.trustedSigners.map(uuidToBytes)], [7, hashToBytes(c.expectedGenesis)],
        [8, state], [9, c.cloudCopyOptIn], [10, b32(c.signSecretKey)], [11, b32(c.kemSecretKey)], [12, opened], [13, c.sqliteVersion], [16, policyPins(c.policyPins)],
      ]));
      if (encoded.length > 64 * 1024) throw bad();
      const error = this.guard(() => this.takeOut(this.app.rt_app_open(...this.put(encoded!))));
      if (error.length) throw bad();
      this.collection = c.collection; this.deviceId = c.deviceId; this.endpoint = endpoint; this.active = true;
      this.markOpened();
    } catch { this.retireLog(); this.fail(); throw bad(); }
    finally { encoded?.fill(0); c.signSecretKey?.fill(0); c.kemSecretKey?.fill(0); }
  }
  override tick(): void { if (this.active && !this.retired) this.guard(() => super.tick()); }
  override connect(options: Parameters<WasmRuntime["connect"]>[0] = {}): ReturnType<WasmRuntime["connect"]> {
    if (!this.active || this.retired || (options.collection !== undefined && (typeof options.collection !== "string" || options.collection.toLowerCase() !== this.collection?.toLowerCase()))) throw bad();
    const port = super.connect(options), send = port.send.bind(port), close = port.close.bind(port);
    port.send = frame => this.guard(() => send(frame));
    port.close = () => this.guard(() => close());
    return port;
  }
  /** Trusted host READ on its actual held port. Native admission/publication
   * remains authoritative. There is no caller-selected session or MemStore path. */
  executeBases(port: ReturnType<WasmRuntime["connect"]>, request: Uint8Array): Uint8Array {
    return this.readBases(port, request, "execute");
  }
  /** Separate native metadata READ exports; never caller sessions or Query RPC. */
  discoverBases(port: ReturnType<WasmRuntime["connect"]>, operation: "list-views" | "read-view-source", request: Uint8Array): Uint8Array {
    if (operation !== "list-views" && operation !== "read-view-source") throw bad();
    return this.readBases(port, request, operation);
  }
  private readBases(port: ReturnType<WasmRuntime["connect"]>, request: Uint8Array, operation: "execute" | "list-views" | "read-view-source"): Uint8Array {
    const session = this.sessionForPort(port);
    const native = operation === "execute" ? this.app.rt_app_bases_execute : operation === "list-views" ? this.app.rt_app_bases_list_views : this.app.rt_app_bases_read_view_source;
    if (!this.active || this.retired || !this.sql || this.sql.needsRecovery || session === null || typeof native !== "function") throw bad();
    if (!(request instanceof Uint8Array) || !request.length || request.length > 128 * 1024) throw mdbaseError("invalid_request", "Bases request bytes exceed bound");
    const owned = new Uint8Array(request);
    try {
      const out = this.guard(() => {
        const packed = uint64(native.call(this.app, session, ...this.put(owned)));
        const length = Number(packed & 0xffffffffn);
        if (!length || length > (operation === "execute" ? 16 : 1) * 1024 * 1024) throw bad();
        return this.takeOut(packed);
      });
      if (!this.active || this.retired || this.sql.needsRecovery || this.sessionForPort(port) !== session) { out.fill(0); throw bad(); }
      return out;
    } finally { owned.fill(0); }
  }
  /** Positive ONLY from native verified-policy signature + retained prefix and
   * live READ session. Ordinary unavailable stays hosted; no saved implication. */
  verifyHandover(port: ReturnType<WasmRuntime["connect"]>, source: AppHandoverSource, witness: Uint8Array): ConfirmedHead | null {
    let bytes: Uint8Array | null = null, device: Uint8Array | null = null;
    try {
      const session = this.sessionForPort(port), collection = source.collection, deviceId = source.deviceId;
      if (!this.active || this.retired || session === null || collection !== this.collection || source.isCurrent() !== true || !(witness instanceof Uint8Array) || witness.length > 64 * 1024) return null;
      bytes = new Uint8Array(witness); device = uuidToBytes(deviceId);
      const out = this.guard(() => this.takeOut(this.app.rt_app_verify_handover(session, ...this.put(device!), ...this.put(bytes!))));
      if (out.length === 0 || this.sessionForPort(port) !== session || source.isCurrent() !== true || source.collection !== collection || source.deviceId !== deviceId) return null;
      const head = this.guard(() => confirmedHead.dec(decode(out)));
      if (head.seq === 0 || [head.chain, head.policyGeneration, head.catalogGeneration].some(h => h === `sha256:${"00".repeat(32)}`)) return null;
      return head;
    } catch { return null; }
    finally { bytes?.fill(0); device?.fill(0); }
  }
  /** One authenticated connector bootstrap pin before any LS binding. */
  bindCpConnector(pin: AppCpConnectorPin): void {
    let bytes: Uint8Array | null = null;
    try {
      if (!this.active || this.retired || this.pump || this.cpPin || pin.isCurrent() !== true || pin.deviceId !== this.deviceId || pin.collection !== this.collection) throw bad();
      const connectorId = pin.connectorId; bytes = uuidToBytes(connectorId);
      if (bytes.every(b => b === 0)) throw bad();
      if (this.guard(() => this.app.rt_app_cp_bind_connector(...this.put(bytes!))) !== 1) throw bad();
      this.connectorId = connectorId; this.cpPin = pin;
    } catch { throw bad(); }
    finally { bytes?.fill(0); }
  }
  private deviceCurrent(): boolean {
    try { const pin=this.devicePin;return this.deviceActive && !this.retired && pin!==null && pin.isCurrent()===true && pin.connectorId===this.connectorId && pin.deviceId===this.deviceId && pin.installationId===this.installationId; } catch {return false;}
  }
  private publicResult(out: Uint8Array): { m: Map<CborValue, CborValue>; identity: AppDevicePublicIdentity } {
    if (out.length > 1024) throw bad();
    const decoded = decode(out);
    if (!(decoded instanceof Map)) throw bad();
    const m = decoded as Map<CborValue,CborValue>;
    if (m.size !== 4 || [0,1,2,3].some(k => !m.has(k))) throw bad();
    const publicKey = (k: number) => { const value = m.get(k); if (!(value instanceof Uint8Array) || value.length !== 32 || value.every(b => b === 0)) throw bad(); return new Uint8Array(value); };
    return { m, identity: Object.freeze({ signPublicKey: publicKey(0), kemPublicKey: publicKey(1), noisePublicKey: publicKey(2) }) };
  }
  /** Phase1 ONLY; no roots/genesis/Core/SQL/LS/RPC. Async protected outer
   * unwrap precedes this sync native operation. Exactly one fresh/restore
   * attempt, consuming BOTH sign/KEM loans; no caller Noise secret. */
  openDeviceConsuming(c: AppDeviceBootstrap): AppNoiseCustodyResult {
    let encoded:Uint8Array|null=null;
    try {
      if (this.deviceAttempted || this.attempted || this.retired) throw bad();this.deviceAttempted=true;
      const pin=c.pin;this.devicePin=pin;this.connectorId=pin.connectorId;this.deviceId=pin.deviceId;this.installationId=pin.installationId;this.deviceActive=true;
      if (!this.deviceCurrent()) throw bad();
      const ids=[this.connectorId,this.deviceId,this.installationId].map(uuidToBytes);
      if (ids.some(id=>id.every(b=>b===0))) throw bad();
      const opened=c.opened;
      if (opened.mode!=="fresh" && opened.mode!=="existing") throw bad();
      if (opened.mode==="existing" && (!(opened.envelope instanceof Uint8Array) || !opened.envelope.length || opened.envelope.length>1024)) throw bad();
      encoded=encodeSecret(new Map<number,CborValue>([[0,1],[1,ids[0]!],[2,ids[1]!],[3,ids[2]!],[4,opened.mode==="fresh"?0:1],[5,b32(c.signSecretKey)],[6,b32(c.kemSecretKey)],[7,opened.mode==="fresh"?new Uint8Array():new Uint8Array(opened.envelope)]]));
      const out=this.guard(()=>this.takeOut(this.app.rt_app_device_open(...this.put(encoded!))));
      if (!out.length || !this.deviceCurrent()) throw bad();
      const result=this.guard(()=>{const {m,identity}=this.publicResult(out);const wrapped=m.get(3);if (!(wrapped instanceof Uint8Array) || !wrapped.length || wrapped.length>1024) throw bad();return {...identity,envelope:new Uint8Array(wrapped)};});
      this.publicIdentity={signPublicKey:new Uint8Array(result.signPublicKey),kemPublicKey:new Uint8Array(result.kemPublicKey),noisePublicKey:new Uint8Array(result.noisePublicKey)};
      this.noiseEnvelope=new Uint8Array(result.envelope);
      return Object.freeze(result);
    } catch {this.retireLog();throw bad();}
    finally {encoded?.fill(0);c.signSecretKey?.fill(0);c.kemSecretKey?.fill(0);}
  }
  /** Public binding check for this exact DEVICE-only custody result. Not an
   * account/app grant, collection readiness or independent key attestation. */
  deviceCustodyCurrent(pin:AppDeviceIdentityPin,custody:AppNoiseCustodyResult):boolean {
    try {
      return this.deviceCurrent() && !this.active && this.publicIdentity!==null && this.noiseEnvelope!==null && pin.isCurrent()===true && pin.connectorId===this.connectorId && pin.deviceId===this.deviceId && pin.installationId===this.installationId && custody.envelope instanceof Uint8Array && custody.envelope.length===this.noiseEnvelope.length && custody.envelope.every((b,i)=>b===this.noiseEnvelope![i]) && (["signPublicKey","kemPublicKey","noisePublicKey"] as const).every(k=>custody[k] instanceof Uint8Array && custody[k].length===32 && custody[k].every((b,i)=>b===this.publicIdentity![k][i]));
    } catch {return false;}
  }
  /** HOST ONLY actual authenticated response/protected stored receipt. Never
   * inferred from ciphertext, same account, persistence or zero pending. */
  acknowledgeDeviceRegistration(receipt: AppDeviceRegistrationReceipt): void {
    let encoded:Uint8Array|null=null;
    try {
      if (!this.deviceCurrent() || this.active || this.deviceRegistered || !this.publicIdentity || receipt.connectorId!==this.connectorId || receipt.deviceId!==this.deviceId || receipt.installationId!==this.installationId) throw bad();
      for (const k of ["signPublicKey","kemPublicKey","noisePublicKey"] as const) if (b32(receipt[k]).some((b,i)=>b!==this.publicIdentity![k][i])) throw bad();
      encoded=encodeSecret(new Map<number,CborValue>([[0,uuidToBytes(receipt.connectorId)],[1,uuidToBytes(receipt.deviceId)],[2,uuidToBytes(receipt.installationId)],[3,new Uint8Array(receipt.signPublicKey)],[4,new Uint8Array(receipt.kemPublicKey)],[5,new Uint8Array(receipt.noisePublicKey)]]));
      if (this.guard(()=>this.app.rt_app_device_registered(...this.put(encoded!)))!==1 || !this.deviceCurrent()) throw bad();this.deviceRegistered=true;
    } catch {this.retireLog();throw bad();}
    finally {encoded?.fill(0);}
  }
  /** Once-pinned CLOUD COPY purpose. Requires actual original registration,
   * no private/SAS context and no seed re-loan, roots or SQL effects. */
  prepareCloudCopyCollection(pin:AppCloudCopyCollectionPin):void {
    let encoded:Uint8Array|null=null;
    try {
      if(pin.approvalMode==="strict")throw new AppStrictDeviceApprovalError();
      if(this.cloudSource||this.privateAttempted||!this.deviceCurrent()||!this.deviceRegistered||this.active||pin.approvalMode!=="password-ak1"||!["create","join"].includes(pin.purpose))throw bad();
      this.cloudSource=pin;this.cloudCallback=pin.isCurrent;this.cloudCollection=pin.collection;this.cloudPurpose=pin.purpose;
      if(!this.cloudCopyCollectionCurrent(pin))throw bad();const collection=uuidToBytes(pin.collection);if(collection.every(v=>v===0))throw bad();
      encoded=encodeSecret(new Map<number,CborValue>([[0,collection],[1,pin.purpose==="create"?0:1]]));
      if(this.guard(()=>this.app.rt_app_cloud_copy_pin(...this.put(encoded!)))!==1||!this.cloudCopyCollectionCurrent(pin))throw bad();
    }catch(error){this.retireLog();if(error instanceof AppStrictDeviceApprovalError)throw error;throw bad();}finally{encoded?.fill(0);}
  }
  cloudCopyCollectionCurrent(source?:AppCloudCopyCollectionPin):boolean {
    try{const p=this.cloudSource;return this.deviceCurrent()&&!this.active&&this.deviceRegistered&&p!==null&&(!source||source===p)&&p.isCurrent===this.cloudCallback&&p.isCurrent()===true&&p.connectorId===this.connectorId&&p.deviceId===this.deviceId&&p.installationId===this.installationId&&p.collection===this.cloudCollection&&p.purpose===this.cloudPurpose&&p.approvalMode==="password-ak1";}catch{return false;}
  }
  /** Fixed native create domain; no configurable digest/subject/signer. */
  signCloudCopyCreate(challenge:Uint8Array):Uint8Array {return this.signCloudCopy(challenge,"create");}
  /** Fixed native join domain; no private enrol/SAS state. */
  signCloudCopyJoin(challenge:Uint8Array):Uint8Array {return this.signCloudCopy(challenge,"join");}
  private signCloudCopy(challenge:Uint8Array,purpose:"create"|"join"):Uint8Array {
    let owned:Uint8Array|null=null,signature:Uint8Array|null=null;
    try{if(this.cloudIssued||!this.cloudCopyCollectionCurrent()||this.cloudPurpose!==purpose)throw bad();this.cloudIssued=true;owned=new Uint8Array(b32(challenge));signature=this.guard(()=>this.takeOut(purpose==="create"?this.app.rt_app_cloud_copy_create_sign(...this.put(owned!)):this.app.rt_app_cloud_copy_join_sign(...this.put(owned!))));if(signature.length!==64||!this.cloudCopyCollectionCurrent())throw bad();return signature;}catch{signature?.fill(0);this.retireLog();throw bad();}finally{owned?.fill(0);}
  }
  /** Host-only ONCE, registered DEVICE phase. No Core/SQL/readiness; no caller
   * fresh JS commit/secret. Existing must come from exact platform-protected
   * public marker; never regenerate after uncertain enrolment. */
  preparePrivateCollection(pin: AppPrivateCollectionPin, opened: AppPrivateCollectionOpen): void {
    let encoded: Uint8Array | null = null, restoredCommit: Uint8Array | null = null;
    try {
      if (pin.approvalMode === "strict") throw new AppStrictDeviceApprovalError();
      if (this.cloudSource || this.privateAttempted || !this.deviceCurrent() || !this.deviceRegistered || this.active || pin.approvalMode !== "password-ak1" || !["create","enrol"].includes(pin.purpose)) throw bad();
      this.privateAttempted=true;this.privateSource=pin;this.prospectiveCollection=pin.collection;this.privatePurpose=pin.purpose;
      if (!this.privateCollectionCurrent()) throw bad();const collection=uuidToBytes(pin.collection);if(collection.every(v=>v===0)) throw bad();
      if(opened.mode==="fresh") {
        encoded=encodeSecret(new Map<number,CborValue>([[0,collection],[1,pin.purpose==="create"?0:1]]));
        if(this.guard(()=>this.app.rt_app_private_collection_pin(...this.put(encoded!)))!==1) throw bad();
      } else if(opened.mode==="existing") {
        const m=opened.marker,p=this.publicIdentity;
        if(pin.purpose!=="enrol" || !p || m.collection!==pin.collection || m.connectorId!==this.connectorId || m.deviceId!==this.deviceId || m.installationId!==this.installationId || typeof m.acknowledged!=="boolean") throw bad();
        for(const k of ["signPublicKey","kemPublicKey","noisePublicKey"] as const) if(!equalBytes(b32(m[k]),p[k])) throw bad();
        const commit=new Uint8Array(b32(m.sasCommitment));if(commit.every(v=>v===0)) throw bad();restoredCommit=commit;
        encoded=encodeSecret(new Map<number,CborValue>([[0,1],[1,collection],[2,uuidToBytes(m.connectorId)],[3,uuidToBytes(m.deviceId)],[4,uuidToBytes(m.installationId)],[5,new Uint8Array(m.signPublicKey)],[6,new Uint8Array(m.kemPublicKey)],[7,new Uint8Array(m.noisePublicKey)],[8,commit],[9,m.acknowledged]]));
        this.privateEnrolAcknowledged=m.acknowledged;
        if(this.guard(()=>this.app.rt_app_private_enrol_restore(...this.put(encoded!)))!==1) throw bad();
      } else throw bad();
      if(!this.privateCollectionCurrent()) throw bad();
      if(pin.purpose==="enrol") {const commit=this.guard(()=>this.takeOut(this.app.rt_app_private_enrol_commitment()));if(commit.length!==32||commit.every(v=>v===0)||(restoredCommit!==null&&!equalBytes(commit,restoredCommit))) throw bad();this.sasCommitment=new Uint8Array(commit);}
    } catch (error) {this.retireLog();if(error instanceof AppStrictDeviceApprovalError) throw error;throw bad();} finally {encoded?.fill(0);}
  }
  /** Actual acknowledged device public receipt, copied; no new authority. */
  registeredDeviceReceipt():AppDeviceRegistrationReceipt {
    if(!this.deviceCurrent()||!this.deviceRegistered||!this.publicIdentity) throw bad();const p=this.publicIdentity;
    return Object.freeze({connectorId:this.connectorId!,deviceId:this.deviceId!,installationId:this.installationId!,signPublicKey:new Uint8Array(p.signPublicKey),kemPublicKey:new Uint8Array(p.kemPublicKey),noisePublicKey:new Uint8Array(p.noisePublicKey)});
  }
  /** Public native-generated/restored marker to protect BEFORE any enrol POST. */
  privateEnrolMarker(): AppPrivateEnrolOperationMarker {
    if(!this.privateCollectionCurrent() || this.privatePurpose!=="enrol" || !this.sasCommitment || !this.publicIdentity) throw bad();
    const p=this.publicIdentity;
    return Object.freeze({connectorId:this.connectorId!,deviceId:this.deviceId!,installationId:this.installationId!,collection:this.prospectiveCollection!,sasCommitment:new Uint8Array(this.sasCommitment),acknowledged:this.privateEnrolAcknowledged,signPublicKey:new Uint8Array(p.signPublicKey),kemPublicKey:new Uint8Array(p.kemPublicKey),noisePublicKey:new Uint8Array(p.noisePublicKey)});
  }
  privateCollectionCurrent(source?:AppPrivateCollectionPin): boolean {
    try {if(source && (source.isCurrent()!==true||source.connectorId!==this.connectorId||source.deviceId!==this.deviceId||source.installationId!==this.installationId||source.collection!==this.prospectiveCollection||source.purpose!==this.privatePurpose||source.approvalMode!=="password-ak1"))return false;const p=this.privateSource;return this.deviceCurrent() && !this.active && this.deviceRegistered && p!==null && p.isCurrent()===true && p.connectorId===this.connectorId && p.deviceId===this.deviceId && p.installationId===this.installationId && p.collection===this.prospectiveCollection && p.purpose===this.privatePurpose && p.approvalMode==="password-ak1";} catch {return false;}
  }
  /** Dedicated private-create signature only, no configurable purpose/PK/digest. */
  signPrivateCreate(challenge: Uint8Array): Uint8Array {
    let owned:Uint8Array|null=null;try {if(!this.privateCollectionCurrent()||this.privatePurpose!=="create") throw bad();owned=new Uint8Array(b32(challenge));const sig=this.guard(()=>this.takeOut(this.app.rt_app_private_create_sign(...this.put(owned!))));if(sig.length!==64||!this.privateCollectionCurrent()) throw bad();return sig;}catch{this.retireLog();throw bad();}finally{owned?.fill(0);}
  }
  /** Native public SAS commitment + dedicated enrol signature. No r/state or
   * caller commit; strict approval/Noise handshake is not implemented in v1. */
  signPrivateDeviceEnrol(challenge: Uint8Array): AppPrivateDeviceEnrolProof {
    let owned:Uint8Array|null=null;try {if(!this.privateCollectionCurrent()||this.privatePurpose!=="enrol"||!this.sasCommitment||this.privateEnrolAcknowledged) throw bad();owned=new Uint8Array(b32(challenge));const signature=this.guard(()=>this.takeOut(this.app.rt_app_private_device_enrol_sign(...this.put(owned!))));if(signature.length!==64||!this.privateCollectionCurrent()) throw bad();return Object.freeze({signature,sasCommitment:new Uint8Array(this.sasCommitment)});}catch{this.retireLog();throw bad();}finally{owned?.fill(0);}
  }
  /** Phase2 consumes SAME native owners with genuine collection trust metadata.
   * NO seed re-export/loan/recreation/rebind; device-phase v1 is unchanged. */
  adoptDevice(c: AppCollectionBootstrap, sql?: AppSqlLifetime): void {
    let encoded:Uint8Array|null=null;
    try {
      if (!this.deviceCurrent() || !this.deviceRegistered || this.attempted || this.active || c.deviceId!==this.deviceId) throw bad();
      if (this.privateSource && (!this.privateCollectionCurrent() || c.collection!==this.prospectiveCollection)) throw bad();
      if(this.cloudSource&&(!this.cloudCopyCollectionCurrent()||c.collection!==this.cloudCollection||c.state!=="cloud_copy"||c.cloudCopyOptIn!==true))throw bad();
      const pins = policyPins(c.policyPins);
      if (sql) {
        if (this.sql || sql.needsRecovery || !this.sqlBinding.exports) throw bad();
        this.sqlBinding.sql=sql;this.sqlBinding.run=sql.import(this.sqlBinding.exports);
      }
      if (!this.sql || this.sql.needsRecovery) throw bad();this.attempted=true;
      const endpoint=uint64(c.endpoint),state=c.state==="e2e"?0:c.state==="cloud_copy"?1:-1,opened=c.opened==="fresh"?0:c.opened==="existing"?1:c.opened==="unclean"?2:-1;
      if (state<0 || opened<0 || typeof c.cloudCopyOptIn!=="boolean" || (state===1)!==c.cloudCopyOptIn || !Array.isArray(c.trustedRoots) || c.trustedRoots.length<1 || c.trustedRoots.length>64 || !Array.isArray(c.trustedSigners) || c.trustedSigners.length>1024 || !Number.isSafeInteger(c.sqliteVersion) || c.sqliteVersion<0 || c.sqliteVersion>0xffff_ffff) throw bad();
      encoded=encodeSecret(new Map<number,CborValue>([[0,4],[1,uuidToBytes(c.collection)],[2,uuidToBytes(c.replicaId)],[3,uuidToBytes(c.deviceId)],[4,endpoint],[5,c.trustedRoots.map(b32)],[6,c.trustedSigners.map(uuidToBytes)],[7,hashToBytes(c.expectedGenesis)],[8,state],[9,c.cloudCopyOptIn],[10,null],[11,null],[12,opened],[13,c.sqliteVersion],[14,uuidToBytes(this.connectorId!)],[15,uuidToBytes(this.installationId!)],[16,pins]]));
      if (encoded.length>64*1024) throw bad();const error=this.guard(()=>this.takeOut(this.app.rt_app_device_adopt(...this.put(encoded!))));
      if (error.length || !this.deviceCurrent()) throw bad();this.collection=c.collection;this.endpoint=endpoint;this.active=true;this.markOpened();
    } catch {this.retireLog();this.fail();throw bad();}
    finally {encoded?.fill(0);}
  }
  /** Separate fixed cp-enrol transcript over internally protected public keys.
   * Borrowed nonce is independently copied; no key/identity/domain/digest inputs. */
  signCpEnrol(challenge: Uint8Array): AppCpEnrolProof {
    let owned: Uint8Array | null = null;
    try {
      if (!this.deviceCurrent() || !this.publicIdentity || this.active || this.pump) {this.retireLog();throw bad();}
      owned = new Uint8Array(b32(challenge));
      const out = this.guard(() => this.takeOut(this.app.rt_app_cp_enrol_sign(...this.put(owned!))));
      if (!this.deviceCurrent()) {this.retireLog();throw bad();}
      if (!out.length) throw bad();
      const { m, identity } = this.guard(() => this.publicResult(out));
      const signature = m.get(3);
      if (!(signature instanceof Uint8Array) || signature.length !== 64 || (["signPublicKey","kemPublicKey","noisePublicKey"] as const).some(k => identity[k].some((b,i) => b !== this.publicIdentity![k][i]))) throw bad();
      return Object.freeze({ ...identity, signature: new Uint8Array(signature) });
    } catch { this.retireLog(); throw bad(); }
    finally { owned?.fill(0); }
  }
  /** Fixed CP purpose; no method/route/domain/digest or identity override. */
  signCpLogToken(challenge: Uint8Array): Uint8Array {
    let owned: Uint8Array | null = null;
    try {
      if (!this.active || this.retired || !this.cpPin) throw bad();
      const pin = this.cpPin;
      let current = false;
      try { current = pin.isCurrent() === true && pin.connectorId === this.connectorId && pin.deviceId === this.deviceId && pin.collection === this.collection; } catch { /* unavailable identity is not authorization */ }
      if (!current) { this.retireLog(); throw bad(); }
      owned = new Uint8Array(b32(challenge));
      const sig = this.guard(() => this.takeOut(this.app.rt_app_cp_log_token_sign(...this.put(owned!))));
      if (sig.length !== 64) { sig.fill(0); throw bad(); }
      return sig;
    } catch { throw bad(); }
    finally { owned?.fill(0); }
  }
  /** Host supplies a genuinely authenticated immutable transport, not a true flag. */
  bindLogTransport(transport: AppLogTransport): AppLogPump {
    try {
      if (!this.active || this.retired || this.pump || this.endpoint === null || this.collection === null || transport.isCurrent() !== true || uint64(transport.endpoint) !== this.endpoint || transport.collection !== this.collection) throw bad();
    } catch { throw bad(); }
    const bytes = uuidToBytes(this.collection);
    if (this.guard(() => this.app.rt_app_log_bind(this.endpoint!, ...this.put(bytes))) !== 1) throw bad();
    this.logGeneration = this.guard(() => uint64(this.app.rt_app_log_generation()));
    if (this.logGeneration === 0n) { this.retireLog(); throw bad(); }
    this.pump = new AppLogPump(this, transport, { endpoint: this.endpoint, collection: this.collection });
    this.transport = transport;
    return this.pump;
  }
  /** HOST ONLY wake AFTER fresh authenticated authority admission: drain/abort
   * original pump before SAME-owner native session/generation replacement. May
   * hang: owner must terminate Worker before releasing lease. Not readiness. */
  async reconnectLogTransport(transport:AppLogTransport):Promise<AppLogPump> {
    const original=this.pump,generation=this.logGeneration,check=()=>this.active&&!this.retired&&this.pump===original&&original!==null&&this.transport===transport&&transport.isCurrent()===true&&uint64(transport.endpoint)===this.endpoint&&transport.collection===this.collection;
    try{if(!check())throw bad();await original!.drainForAuthenticatedReconnect();if(!check())throw bad();this.pump=null;this.transport=null;const bytes=uuidToBytes(this.collection!);try{if(this.guard(()=>this.app.rt_app_log_reconnect(this.endpoint!,...this.put(bytes)))!==1)throw bad();}finally{bytes.fill(0);}this.logGeneration=this.guard(()=>uint64(this.app.rt_app_log_generation()));if(this.logGeneration<=generation||!transport.isCurrent()||this.retired||!this.active)throw bad();this.pump=new AppLogPump(this,transport,{endpoint:this.endpoint!,collection:this.collection!});this.transport=transport;return this.pump;}catch{this.retireLog();throw bad();}
  }
  /** Protected fixed-domain authority callback. Rust checks the original exact
   * frame or its associated same-address commit; JS digest is NOT signing input. */
  signLogHttp(proof: AppLogHttpProof): Uint8Array {
    let encoded: Uint8Array | null = null;
    try {
      if (!this.active || !this.pump || !this.transport || this.logGeneration === 0n || this.endpoint === null || proof.path !== "/v1/rpc" || proof.collection !== this.collection || uint64(proof.endpoint) !== this.endpoint || !this.transport.isCurrent()) throw bad();
      if (!(proof.frame instanceof Uint8Array) || proof.frame.length === 0 || proof.frame.length > 16 * 1024 * 1024 || !(proof.nonce instanceof Uint8Array) || proof.nonce.length !== 32 || typeof proof.token !== "string" || proof.token.length === 0 || proof.token.length > 16 * 1024 || /[^\x21-\x7e]/.test(proof.token)) throw bad();
      encoded = encodeSecret(new Map<number, CborValue>([[0, proof.frame], [1, proof.token], [2, proof.nonce]]));
      const signature = this.guard(() => this.takeOut(this.app.rt_app_log_http_sign(this.endpoint!, this.logGeneration, uint64(proof.originalCallId), ...this.put(encoded!))));
      if (signature.length !== 64) { signature.fill(0); throw bad(); }
      return signature;
    } catch { throw bad(); }
    finally { encoded?.fill(0); }
  }
  takeLogCalls(): readonly AppLogCall[] {
    if (!this.active || this.retired) return [];
    return this.guard(() => {
      const bytes = this.takeOut(this.app.rt_app_log_calls());
      if (!bytes.length) return [];
      const records = decode(bytes);
      if (!Array.isArray(records) || records.length > 64) throw bad();
      return records.map(record => {
        if (!(record instanceof Map)) throw bad();
        const fields = record as Map<CborValue, CborValue>;
        const endpoint = fields.get(0), frame = fields.get(1), sidecar = fields.get(2);
        if (uint64(endpoint) !== this.endpoint || !(frame instanceof Uint8Array) || (sidecar !== undefined && !(sidecar instanceof Uint8Array))) throw bad();
        return { endpoint: endpoint as number | bigint, frame, ...(sidecar !== undefined ? { sidecar } : {}) };
      });
    });
  }
  acceptLogReply(id: bigint, bytes: Uint8Array): boolean {
    if (!this.active || this.retired) return false;
    return this.guard(() => this.app.rt_app_log_reply(uint64(id), ...this.put(bytes)) === 1);
  }
  logNoResponse(id: bigint): void { if (this.active && !this.retired) this.guard(() => this.app.rt_app_log_no_response(uint64(id))); }
  retireLog(): void {
    this.logGeneration = 0n;
    if (this.retired) return;
    this.retired = true;
    this.cpPin = null; this.connectorId = null;
    this.devicePin = null; this.installationId = null; this.privateSource=null;this.prospectiveCollection=null;this.privatePurpose=null;this.sasCommitment?.fill(0);this.sasCommitment=null; this.publicIdentity = null;this.noiseEnvelope?.fill(0);this.noiseEnvelope=null;this.deviceActive=false;this.deviceRegistered=false;
    if (this.active) this.guard(() => { super.dispose(); this.app.rt_app_log_retire(); });
    else if (this.deviceAttempted) this.guard(()=>this.app.rt_app_device_retire());
  }
  /** Current authenticated service push only; transport fences its generation. */
  pushLog(bytes: Uint8Array): boolean {
    if (!this.active || this.retired || !this.pump || !this.transport) return false;
    return this.guard(() => {
      const t = this.transport!;
      if (t.isCurrent() !== true || uint64(t.endpoint) !== this.endpoint || t.collection !== this.collection) { this.retireLog(); return false; }
      return this.app.rt_app_log_push(...this.put(bytes)) === 1;
    });
  }
  private accountKeyCurrent(pin:AppAccountKeyPin):boolean {
    try{return this.active&&!this.retired&&pin.isCurrent()===true&&pin.approvalMode==="password-ak1"&&pin.collection===this.collection&&pin.deviceId===this.deviceId&&pin.connectorId===this.connectorId&&pin.installationId===this.installationId&&this.devicePin!==null&&this.devicePin.isCurrent()===true&&this.devicePin.connectorId===this.connectorId&&this.devicePin.deviceId===this.deviceId&&this.devicePin.installationId===this.installationId;}catch{return false;}
  }
  private accountKeyState(bytes:Uint8Array):AppAccountKeyState {
    const value=decode(bytes);if(!(value instanceof Map))throw bad();const m=value as Map<CborValue,CborValue>;if(m.size!==2||!m.has(0)||!m.has(1))throw bad();const state=m.get(0),reason=m.get(1);
    if(state===0||state===1){if(reason!==null)throw bad();return Object.freeze({state:state===0?"pending":"keyed"});}
    const reasons:AppAccountKeyRefusal[]=["not_private","not_ready","not_enrolled","not_authorized","device_missing","enrolment_mismatch","not_keyed","no_wrap","inconsistent","failed","outcome_unknown"];
    if(state!==2||typeof reason!=="string"||!reasons.includes(reason as AppAccountKeyRefusal))throw bad();return Object.freeze({state:"refused",reason:reason as AppAccountKeyRefusal});
  }
  /** Protected transient R32 loan, consumed/wiped even when refused/trapped.
   * Native derives only this collection; pending/queued is NOT keyed. */
  unlockAccountKeyConsuming(pin:AppAccountKeyPin,secret:Uint8Array):AppAccountKeyState {
    try{if(pin.approvalMode==="strict")throw new AppStrictDeviceApprovalError();if(!this.accountKeyCurrent(pin))throw bad();b32(secret);const state=this.guard(()=>this.accountKeyState(this.takeOut(this.app.rt_app_account_key_unlock(...this.put(secret)))));if(!this.accountKeyCurrent(pin))throw bad();return state;}catch(error){this.retireLog();if(error instanceof AppStrictDeviceApprovalError)throw error;throw bad();}finally{if(secret instanceof Uint8Array)secret.fill(0);}
  }
  /** Protected R32 setup loan, consumed even when refused/trapped. Only an
   * existing CP-enrolled EXACT recovery device; queued != recovery_keyed, and
   * recovery_keyed != this app keyed/Saved. Ordinary native KEY_GRANT only. */
  setupAccountKeyDeviceConsuming(pin:AppAccountKeyPin,secret:Uint8Array):AppAccountKeyDeviceSetupState {
    try{if(pin.approvalMode==="strict")throw new AppStrictDeviceApprovalError();if(!this.accountKeyCurrent(pin))throw bad();b32(secret);const state=this.guard(()=>this.accountKeyState(this.takeOut(this.app.rt_app_account_key_device_setup(...this.put(secret)))));if(!this.accountKeyCurrent(pin))throw bad();return state.state==="refused"?state:Object.freeze({state:state.state==="keyed"?"recovery_keyed":"recovery_pending"});}catch(error){this.retireLog();if(error instanceof AppStrictDeviceApprovalError)throw error;throw bad();}finally{if(secret instanceof Uint8Array)secret.fill(0);}
  }
  /** Actual native applied-policy/trust status; not zero-pending/readback/Saved. */
  accountKeyStatus(pin:AppAccountKeyPin):AppAccountKeyState {
    try{if(!this.accountKeyCurrent(pin))throw bad();const state=this.guard(()=>this.accountKeyState(this.takeOut(this.app.rt_app_account_key_status())));if(!this.accountKeyCurrent(pin))throw bad();return state;}catch{this.retireLog();throw bad();}
  }
  observations(): AppRuntimeObservations {
    if (!this.active || this.retired) throw bad();
    return this.guard(() => {
      const value = decode(this.takeOut(this.app.rt_app_observations()));
      if (!(value instanceof Map)) throw bad();
      const m = value as Map<CborValue, CborValue>;
      for (const k of [1, 2, 3, 4]) if (typeof m.get(k) !== "boolean") throw bad();
      return { status: syncStatus.dec(m.get(0)!), keyringRebuilding: m.get(1) as boolean, keyringRebuildFailed: m.get(2) as boolean, snapshotInstallAvailable: m.get(3) as boolean, requiresReopen: m.get(4) as boolean };
    });
  }
  /** Drain/abort current generation BEFORE key/runtime/SQL shutdown. May hang;
   * owner must terminate the Worker before releasing its lease in that case. */
  async close(): Promise<boolean> {
    if (this.pump) { await this.pump.close(); this.pump = null; this.transport = null; }
    return this.shutdown();
  }
  /** Synchronous clean shutdown only with no undrained pump. Not a saved claim. */
  shutdown(): boolean {
    if (!this.active) {if (this.deviceAttempted && !this.retired) this.retireLog();this.discard();return false;}
    if (this.pump) { void this.pump.close().catch(() => {}); this.fail(); return false; }
    try {
      this.retireLog(); super.dispose();
      return this.guard(() => this.app.rt_app_shutdown() === 1) && this.sql!==null && !this.sql.needsRecovery;
    } finally { this.active = false; this.discard(); }
  }
  override dispose(): void { this.shutdown(); }
}
