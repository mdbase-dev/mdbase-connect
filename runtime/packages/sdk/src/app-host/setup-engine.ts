/** Stateless collection setup planning over an inventory the caller read
 * through its own client session (a Private collection over the relay). The
 * same native engine and review digest as a hosted collection's setup; no
 * runtime open, session, SQL or write. The planned writes are guarded, and
 * the collection's own replica enforces them when the caller submits. */
import { decode, encode, type CborValue } from "../cbor.js";
import { mdbaseError } from "../errors.js";
import { WasmRuntime, type Exports } from "../runtime/wasm.js";
import { resourceAssessment, resourceDecisions, type AppResourceAssessment, type AppResourceDecisions } from "./collection-control.js";
import { modelResourcePlan } from "./collection-setup-journal.js";
import type { ModelResourcePlan } from "./collection-setup-types.js";
import { resourceJson } from "./wasm-runtime.js";

/** Confirmed `[path, source]` rows in strictly ascending path order. */
export type AppSetupInventory = readonly (readonly [string, string])[];
interface SetupExports extends Exports { rt_app_setup_assess?(p: number, n: number): bigint; }
const OUTPUT_MAX = 512 * 1024, INPUT_MAX = 512 * 1024 + 8_388_608 + 16 * 4096;
const unsupported = () => mdbaseError("unavailable", "resource setup unsupported", "resource_setup_unsupported");
const unavailable = () => mdbaseError("unavailable", "resource setup unavailable", "resource_setup_unavailable");

export class AppSetupEngine extends WasmRuntime {
  private constructor(private readonly native: SetupExports) { super(native); }
  static async create(bytes: BufferSource): Promise<AppSetupEngine> {
    const x = await this.load(bytes) as SetupExports;
    if (!(x.memory instanceof WebAssembly.Memory) || typeof x.rt_app_setup_assess !== "function") throw unsupported();
    return new AppSetupEngine(x);
  }
  /** Passing decisions (even `{}`) asks for the review. */
  assess(manifest: unknown, inventory: AppSetupInventory, decisions?: AppResourceDecisions): AppResourceAssessment {
    return resourceAssessment(this.call(false, manifest, null, inventory, decisions), decisions !== undefined);
  }
  plan(manifest: unknown, expected: string, inventory: AppSetupInventory, decisions?: AppResourceDecisions): ModelResourcePlan {
    if (!/^sha256:[0-9a-f]{64}$/.test(expected)) throw mdbaseError("invalid_request", "invalid assessment digest");
    return modelResourcePlan(this.call(true, manifest, expected, inventory, decisions));
  }
  private call(apply: boolean, manifest: unknown, expected: string | null, inventory: AppSetupInventory, decisions?: AppResourceDecisions): unknown {
    const request: CborValue[] = [1, apply ? 1 : 0, resourceJson(manifest, true) as CborValue, expected,
      inventory.map(([path, source]) => [path, source])];
    if (decisions !== undefined) request.push(resourceJson(resourceDecisions(decisions), true) as CborValue);
    const input = encode(request);
    if (input.length > INPUT_MAX) { input.fill(0); throw mdbaseError("invalid_request", "resource DATA exceeds bound"); }
    let output: Uint8Array | undefined;
    try {
      const native = this.native.rt_app_setup_assess!;
      try {
        const packed = BigInt.asUintN(64, native.call(this.x, ...this.put(input)));
        const length = Number(packed & 0xffffffffn);
        if (!length || length > OUTPUT_MAX) throw unavailable();
        output = this.takeOut(packed);
      } catch (error) { this.discard(); throw error; }
      const response = decode(output);
      if (!Array.isArray(response) || response.length !== 3 || response[0] !== 1 || typeof response[1] !== "boolean") throw unavailable();
      if (response[1] === false) throw unavailable();
      return resourceJson(response[2], false);
    } finally { input.fill(0); output?.fill(0); }
  }
}
