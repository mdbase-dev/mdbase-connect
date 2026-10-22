import { randomUUID } from "node:crypto";
import type { DatabasePool } from "./database-types.js";

// pg-mem compatibility for local/test "memory" databases only. Production
// connects through pg in db.ts; nothing here runs against PostgreSQL.
export async function openMemoryDatabase(): Promise<DatabasePool> {
  const { DataType, newDb } = await import("pg-mem");
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  // PostgreSQL char_length counts Unicode characters, not UTF-16 units.
  memory.public.registerFunction({name:"char_length",args:[DataType.text],returns:DataType.integer,
    implementation:(value:string)=>Array.from(value).length});
  // Schema compatibility only for the fixed timer namespace CHECK; real
  // PostgreSQL tests qualify constraints and transaction/lock semantics.
  memory.public.registerOperator({
    operator: "~", left: DataType.text, right: DataType.text, returns: DataType.bool,
    implementation: (value: string, pattern: string) => {
      if (pattern !== "^[A-Za-z0-9._-]{1,64}$") throw new Error("Unsupported memory regex constraint.");
      return value.length >= 1 && value.length <= 64 && !/[^A-Za-z0-9._-]/u.test(value);
    }
  });
  // Schema compatibility for the installation_origins object CHECK. Real
  // PostgreSQL tests qualify the persisted constraint and authorization.
  memory.public.registerFunction({
    name: "jsonb_typeof", args: [DataType.jsonb], returns: DataType.text,
    implementation: (value: unknown) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value
  });
  memory.public.registerFunction({
    name: "pg_advisory_xact_lock",
    args: [DataType.integer],
    returns: DataType.bool,
    implementation: () => true
  });
  memory.public.registerFunction({
    name: "pg_advisory_xact_lock",
    args: [DataType.integer, DataType.integer],
    returns: DataType.bool,
    implementation: () => true
  });
  memory.public.registerFunction({
    name: "pg_try_advisory_lock",
    args: [DataType.integer, DataType.integer],
    returns: DataType.bool,
    implementation: () => true
  });
  memory.public.registerFunction({
    name: "pg_advisory_unlock",
    args: [DataType.integer, DataType.integer],
    returns: DataType.bool,
    implementation: () => true
  });
  memory.public.registerFunction({
    name: "octet_length",
    args: [DataType.bytea],
    returns: DataType.integer,
    implementation: (value: Uint8Array) => value.length
  });
  memory.public.registerFunction({
    name: "octet_length",
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (value: string) => Buffer.byteLength(value, "utf8")
  });
  memory.public.registerFunction({
    name: "clock_timestamp",
    returns: DataType.timestamptz,
    impure: true,
    implementation: () => new Date()
  });
  memory.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    impure: true,
    implementation: () => randomUUID()
  });
  memory.public.registerFunction({
    name: "replace",
    args: [DataType.text, DataType.text, DataType.text],
    returns: DataType.text,
    implementation: (value: string, from: string, to: string) =>
      value.split(from).join(to)
  });
  // pg-mem cannot execute this one PostgreSQL locking CTE. Recognize its
  // private marker and preserve equivalent single-process test semantics.
  memory.public.interceptQueries((sql) => {
    // pg-mem cannot execute PL/pgSQL triggers. Schema-only compatibility:
    // the real Postgres grant-policy suite qualifies every revocation hook,
    // including raw bulk SQL and cascading deletes (never pg-mem).
    // Only migration0062's schema prefix is adapted; no trigger/currentness
    // authority is emulated. Its real PostgreSQL suite is mandatory.
    // Timing constraints/functions have no schema columns to emulate. They
    // require real PostgreSQL; pg-mem is never retention/claim qualification.
    if (sql.includes("-- mdbase:next-migration-archive-elapsed:v1")) return [];
    // Native background-grant hooks/FK upgrades require real PostgreSQL.
    // Keep memory tests on their existing legacy FKs; no native revocation,
    // raw-insert/cascade or consent qualification is emulated here.
    const backgroundHooks = "-- mdbase:native-background-grant-hooks:v1";
    if (sql.includes(backgroundHooks)) {
      const schemaSql = sql.slice(0, sql.indexOf(backgroundHooks));
      // The validation-only follow-up has no schema prefix. Memory retains
      // legacy FKs; real PostgreSQL alone qualifies native FK validation.
      return schemaSql.trim() ? memory.public.many(schemaSql) : [];
    }
    // Only migration0076 schema is emulated. Its immutable/publication
    // trigger is qualified by collection-creation.postgres.test.ts, never
    // by memory tests or browser previews.
    const accountIntentTrigger = "-- mdbase:account-collection-intent-immutable:v1";
    if (sql.includes(accountIntentTrigger)) return memory.public.many(sql.slice(0, sql.indexOf(accountIntentTrigger)));
    const archiveTrigger = "-- mdbase:next-migration-archive-triggers:v1";
    if (sql.includes(archiveTrigger)) return memory.public.many(
      sql.slice(0, sql.indexOf(archiveTrigger)).replace("DEFAULT date_trunc('milliseconds', clock_timestamp())", "DEFAULT now()")
    );
    // pg-mem cannot execute this UPDATE FROM self-join. Empty fixture schemas
    // need only the column; populated backfills require real PostgreSQL.
    const nameBackfill = "-- mdbase:next-display-name-backfill:v1";
    if (sql.includes(nameBackfill)) {
      const result = memory.public.many(sql.slice(0, sql.indexOf(nameBackfill)));
      if (memory.public.one("SELECT count(*) AS n FROM next_collections").n !== 0) {
        throw new Error("Populated collection-name backfill requires PostgreSQL.");
      }
      return result;
    }
    // pg-mem cannot execute the DO block that discovers the predecessor
    // target CHECK. Memory keeps the two-way CHECK: native-collection grants
    // are qualified by real PostgreSQL only.
    const grantTarget = "-- mdbase:next-collection-grant-target:v1";
    if (sql.includes(grantTarget)) return memory.public.many(sql.slice(0, sql.indexOf(grantTarget)));
    // pg-mem lacks JSONB key-array subtraction / JSONPath. Keep the column
    // and object CHECK only; origin-shape enforcement requires real PG tests.
    const timerOriginShape = "-- mdbase:next-timer-legacy-import-origin-shape:v1";
    if (sql.includes(timerOriginShape)) return memory.public.many(sql.slice(0, sql.indexOf(timerOriginShape)));
    // pg-mem lacks the array functions and operators of the file access
    // CHECKs. Keep the columns; shape enforcement requires real PG tests.
    const fileAccessShape = "-- mdbase:installation-file-access-shape:v1";
    if (sql.includes(fileAccessShape)) return memory.public.many(sql.slice(0, sql.indexOf(fileAccessShape)));
    // pg-mem lacks recovery array/null-safe CHECKs and deferred triggers.
    // Schema-only prefix for existing memory consumers; recovery authority
    // and partial-commit invariants are qualified by real PostgreSQL only.
    // The compound Native/installation checks need real PostgreSQL too.
    // Keep its relational schema for memory consumers, never emulate consent.
    const nativeShape = "-- mdbase:installation-native-constraints:v1";
    if (sql.includes(nativeShape)) return memory.public.many(sql.slice(0, sql.indexOf(nativeShape)));
    const recoveryShape = "-- mdbase:installation-recovery-target-constraints:v1";
    if (sql.includes(recoveryShape)) return memory.public.many(sql.slice(0, sql.indexOf(recoveryShape)));
    const grantTrigger = "-- mdbase:next-grant-revoke-trigger:v1";
    if (sql.includes(grantTrigger)) return memory.public.many(sql.slice(0, sql.indexOf(grantTrigger)));
    // pg-mem does not use PostgreSQL's automatic CHECK name. Name ONLY the
    // original fixed device-kind CHECK so migration0055 replaces it exactly,
    // without editing historical SQL/checksums or weakening either constraint.
    if (sql.includes("CREATE TABLE next_devices (") && sql.includes("kind text NOT NULL CHECK (kind IN ('desktop', 'cli'))")) {
      return memory.public.many(sql.replace("kind text NOT NULL CHECK (kind IN ('desktop', 'cli'))", "kind text NOT NULL CONSTRAINT next_devices_kind_check CHECK (kind IN ('desktop', 'cli'))"));
    }
    if (sql.trimStart().startsWith("/* mdbase:timer-authority-current:v1 */")) {
      // pg-mem accepts FOR SHARE but not its OF alias list. It cannot qualify
      // locks/currentness; real PostgreSQL HTTP wait/revocation tests do that.
      const aliases = /\s+FOR SHARE OF (?:tok, g, u|g, u)\s*;?$/u;
      if (!aliases.test(sql)) throw new Error("Unexpected timer authority locking shape.");
      return memory.public.many(sql.replace("/* mdbase:timer-authority-current:v1 */", "").replace(aliases, " FOR SHARE"));
    }
    const marker = "/* mdbase:application-reconciliation-claim:v1 */";
    if (!sql.trimStart().startsWith(marker)) return null;
    const lockClause = /\s+FOR UPDATE SKIP LOCKED/g;
    if ([...sql.matchAll(lockClause)].length !== 1) {
      throw new Error("The marked reconciliation claim has an unexpected locking shape.");
    }
    const unlocked = sql.replace(lockClause, "");
    const cte = unlocked.match(/^\s*\/\*[^*]+\*\/\s*WITH candidate AS \(([\s\S]*?)\)\s*UPDATE /);
    const join = "FROM candidate WHERE job.application_id=candidate.application_id";
    if (!cte || !unlocked.includes(join)) {
      throw new Error("The marked reconciliation claim cannot be adapted for pg-mem.");
    }
    const compatible = unlocked
      .replace(/^\s*\/\*[^*]+\*\/\s*WITH candidate AS \([\s\S]*?\)\s*(?=UPDATE )/, "")
      .replace(join, `WHERE application_id=(${cte[1]})`)
      .replace(" AS job SET", " SET")
      .replaceAll("job.", "");
    return memory.public.many(compatible);
  });
  // pg-mem's pg adapter stringifies Buffer parameters as UTF-8 SQL literals:
  // bytes can be lost, and random backslashes can crash its escape-string lexer.
  // Hex parameters retain every byte; decode is confined to this memory adapter.
  memory.public.registerFunction({
    name: "decode", args: [DataType.text, DataType.text], returns: DataType.bytea,
    implementation: (value: string, format: string) => {
      if (format !== "hex" || !/^(?:[0-9a-f]{2})*$/u.test(value)) throw new Error("Unsupported memory bytea encoding.");
      return Buffer.from(value, "hex");
    }
  });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool() as unknown as DatabasePool;
  const query = pool.query.bind(pool);
  pool.query = (text, values) => {
    if (!values?.some(Buffer.isBuffer)) return query(text, values);
    const encoded = values.map(value => Buffer.isBuffer(value) ? value.toString("hex") : value);
    const sql = text.replace(/\$(\d+)/gu, (parameter, index: string) =>
      Buffer.isBuffer(values[Number(index) - 1]) ? `decode(${parameter},'hex')` : parameter);
    return query(sql, encoded);
  };
  return pool;
}
