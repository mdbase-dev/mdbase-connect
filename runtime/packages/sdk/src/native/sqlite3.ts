import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type {AppCollectionSqlOptions} from "../app-storage/collection-sql.js";

/** Source-only development bridge. Packaging replaces this module with the
 * exact locked official browser dist/index.mjs, never the Node initializer. */
// Official dist/index.mjs forwards ...args to Emscripten's moduleArg (including
// wasmBinary); its published TypeScript declaration omits that startup argument.
const initialize:AppCollectionSqlOptions["initialize"]=options=>Reflect.apply(sqlite3InitModule,undefined,[options]);
export default initialize;
