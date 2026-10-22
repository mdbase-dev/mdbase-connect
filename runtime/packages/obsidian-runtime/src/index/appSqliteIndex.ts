/** Compatibility entry for existing app consumers. SDK owns the implementation;
 * the original physical app VFS/database/clean flags and failure semantics stay. */
export { AppSqliteIndex, appPoolNames, openAppSahpoolIndex, APP_INDEX_LIMITS, AppBinaryIndexHost, appSqlHost } from "@mdbase-dev/sdk/app-storage";
export type { AppStorageScope, AppSqlWasmExports } from "@mdbase-dev/sdk/app-storage";
