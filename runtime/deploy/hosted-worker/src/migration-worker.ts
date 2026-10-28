/**
 * Shared migration deployment entry for LAB, staging and production.
 * Reuses the normal Worker/engine; only installs the Hyperdrive pg factory.
 * Importing this entry does not connect, acquire credentials or open source keys.
 * Deploy with nodejs_compat and independently authenticated migration bindings.
 * Normal/retired serving uses worker.ts without legacy custody.
 */
import { Client } from "pg";
import handler, { HostedCollection } from "./worker.ts";

HostedCollection.legacyConnect = connectionString => new Client({ connectionString });

export { HostedCollection };
export default handler;
