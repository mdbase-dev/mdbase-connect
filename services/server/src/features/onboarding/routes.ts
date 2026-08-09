import type { FastifyInstance } from "fastify";
import {
  provisionStarterCollection,
  starterEditorUrl,
  type StarterCollectionRouteOptions
} from "../../account-onboarding.js";
import { apiError } from "../../platform/http-errors.js";
import { requireUser } from "../../platform/request-authentication.js";

export function registerOnboardingRoutes(
  app: FastifyInstance,
  options: StarterCollectionRouteOptions
): void {
  app.post("/v1/onboarding/starter-collection", async (request, reply) => {
    const user = await requireUser(request, reply, options.db);
    if (!user) return;
    if (!options.hostedCollections || !options.hostedProvider) {
      return reply.code(404).send(apiError("not_found", "Not found."));
    }
    const result = await provisionStarterCollection(
      options,
      options.publicUrl,
      user.id
    );
    if (result.status === "not_scheduled") {
      return reply.code(404).send(apiError(
        "onboarding_not_scheduled",
        "No starter collection is scheduled for this account."
      ));
    }
    const editorUrl = starterEditorUrl(
      options.editorOrigin,
      options.publicUrl,
      result.collectionId
    );
    if (result.status === "pending") {
      return reply.code(202).send({ status: "pending" });
    }
    return {
      status: result.status,
      collection_id: result.collectionId,
      editor_url: editorUrl
    };
  });
}
