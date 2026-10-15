import type {FastifyInstance} from "fastify";
import {z} from "zod";
import type {DatabaseConnection} from "../../database-types.js";
import {apiError} from "../../platform/http-errors.js";
import {requireSessionContext, requireUser} from "../../platform/request-authentication.js";
import {ianaTimezoneSchema} from "../../platform/timezones.js";
import {currentAccount, currentSession, refuse} from "../next/bootstrap-common.js";
import {collectionDisplayName} from "../next/collection-display-name.js";
import {createAccountCollection, type AccountCollectionCreationOptions} from "./collection-creation.js";

const uuid = z.uuid().transform(value => value.toLowerCase()).refine(value => value !== "00000000-0000-0000-0000-000000000000");
const body = z.object({account_id: uuid, request_id: uuid, display_name: z.string(), timezone: ianaTimezoneSchema}).strict();
export function registerAccountCollectionCreationRoutes(app: FastifyInstance, options: AccountCollectionCreationOptions & {tailscaleAuth?: boolean}): void {
  app.post("/v1/account/collections", {bodyLimit:4096, config:{rateLimit:{max:6,timeWindow:"1 minute"}}}, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const parsed = body.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(apiError("invalid_request", "A collection name, time zone and original creation request are required."));
    let displayName: string;
    try {displayName = collectionDisplayName(parsed.data.display_name);}
    catch (error) {return refuse(reply, error, "Use a single-line collection name of 1–200 UTF-16 units.");}
    let account: string;
    let principal: (client: DatabaseConnection) => Promise<void>;
    if (options.tailscaleAuth) {
      const user = await requireUser(request, reply, options.db, true);
      if (!user) return reply;
      account = user.id;
      principal = client => currentAccount(client, user.id);
    } else {
      const context = await requireSessionContext(request, reply, options.db);
      if (!context) return reply;
      account = context.user.id;
      principal = client => currentSession(client, context.sessionId, context.user.id);
    }
    if (parsed.data.account_id !== account) return reply.code(409).send(apiError("account_changed", "Your account changed. Sign in again before creating a collection."));
    try {
      const collection = await createAccountCollection(options, account, {requestId:parsed.data.request_id, displayName, timezone:parsed.data.timezone}, principal);
      return {collection};
    } catch (error) {
      return refuse(reply, error, "The collection could not be created. Retry this same request; do not start another one.");
    }
  });
}
