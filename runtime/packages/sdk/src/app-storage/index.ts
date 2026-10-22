/** Trusted same-Worker native SQL engine; no account/installation authority,
 * vault/editor coupling, in-memory fallback or physical-durability claim. */
export { SqliteIndex, IndexError, classifyError } from "./sqlite-index.js";
export type { SqlValue, Stmt, Batch, StmtResult, IndexResultLimits, IndexInfo, IndexErrorKind } from "./sqlite-index.js";
export { AppSqliteIndex, appPoolNames, openAppSahpoolIndex } from "./app-sqlite-index.js";
export type { AppStorageScope } from "./app-sqlite-index.js";
export { APP_INDEX_LIMITS, AppBinaryIndexHost, appSqlHost } from "./app-binary-index.js";
export type { AppSqlWasmExports } from "./app-binary-index.js";
export { createAppCollectionSql, AppCollectionSqlError } from "./collection-sql.js";
export type { AppCollectionSqlOptions, AppOpenedCollectionSql } from "./collection-sql.js";
