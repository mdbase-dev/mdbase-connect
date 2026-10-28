// TEST HARNESS: original Worker constructor + original inherited executor factory.
// TypeScript-private methods are ordinary JS methods after esbuild. Only the
// native MigrationHost boundary is replaced; source closure/bridge are untouched.
import entry, { HostedCollection } from "../../src/migration-worker.ts";
import servingEntry from "../../src/worker.ts";
import { MigrationExecutor } from "../../src/migration-executor.ts";
import { BoundLegacySource } from "../../src/legacy-source/bindings.ts";
import { LegacySource } from "../../src/legacy-source/source.ts";
import { newRun, storageRunStore, STEP } from "../../src/migration-run.ts";
import { FakeNative, HOLD } from "./migration-fake-native.ts";
import { configure, trace } from "./legacy-source-bridge-pg.mjs";

export class BridgeProbe extends HostedCollection {
  migrationHost() {
    if (this.native) return this.native;
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE bridge_native(k INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    const store = {
      read: () => { const r = sql.exec("SELECT v FROM bridge_native WHERE k=0").toArray()[0]; return r ? JSON.parse(r.v) : null; },
      write: s => sql.exec("INSERT INTO bridge_native VALUES(0,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", JSON.stringify(s)),
      sync: () => this.ctx.storage.sync(),
    };
    this.native = new FakeNative([
      { kind: 2, fields: [null, 40], step: STEP.created, settle: "source" },
      { kind: 3, fields: [null, 2, null, 10], step: STEP.routed, settle: "source" },
    ], store, {}, this.target);
    return this.native;
  }
  async fetch(request) {
    const url = new URL(request.url), op = url.pathname;
    this.target = url.searchParams.get("collection") ?? this.env.FIXTURE.collection;
    configure(this.env.FIXTURE);
    const imports = () => globalThis.__bridgeImports;
    const snapshot = extra => Response.json({ ...extra, trace, imports: imports(), fetches: globalThis.__bridgeFetches, installed: typeof HostedCollection.legacyConnect === "function" });
    if (op === "/entry") return snapshot({ defaultPreserved: entry === servingEntry, inherited: this instanceof HostedCollection });
    if (op === "/unset") return snapshot({});
    if (op === "/bound" || op === "/foreign-checkpoint") {
      try {
        const source = await this.legacyMigrationSource(this.target);
        const shape = { bound: source instanceof BoundLegacySource, realSource: source instanceof LegacySource,
          collection: source.collection };
        if (op === "/foreign-checkpoint") {
          await source.openCheckpoint({ collection: this.env.FOREIGN, S0: 40, expectedState: "migrating", backupHold: HOLD,
            retainUntil: "2099-01-01T00:00:00Z" }, AbortSignal.timeout(5000));
          throw Error("fixture_foreign_checkpoint_was_admitted");
        }
        return snapshot(shape);
      } catch (error) { return snapshot({ code: error.code, error: error.message }); }
    }
    const runs = storageRunStore(this.ctx.storage);
    const run = newRun(this.target, HOLD, Date.now());
    if (op === "/retired" || op === "/stopped") { run.state = op === "/retired" ? "done" : "stopped"; run.reason = op === "/stopped" ? "operator_stop" : null; }
    await runs.save(run);
    const executor = this.migrationExecutor(this.target); // inherited original, NOT reconstructed
    const result = await executor.wake(AbortSignal.timeout(5000), { actions: 4, ms: 5000 });
    return snapshot({ result, realExecutor: executor instanceof MigrationExecutor,
      settlements: this.native?.results ?? [], calls: this.native?.calls ?? [], native: this.native?.state(), run: await runs.load() });
  }
}
export default {
  fetch(request, env, ctx) {
    // Model the normal/retired serving entry's NULL factory BEFORE the original
    // actor constructor, not merely after construction of an installed entry.
    if (new URL(request.url).pathname === "/unset") HostedCollection.legacyConnect = null;
    // Exercise the original re-exported default handler when requested.
    if (new URL(request.url).pathname === "/health") return entry.fetch(request, env, ctx);
    return env.PROBE.getByName("bridge-unit").fetch(request);
  },
};
