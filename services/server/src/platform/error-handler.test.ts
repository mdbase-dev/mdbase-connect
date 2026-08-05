import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { HostedProviderResponseError } from "../hosted-provider.js";
import { registerErrorHandler } from "./error-handler.js";

const applications = [] as Array<ReturnType<typeof Fastify>>;

afterEach(async () => {
  while (applications.length) await applications.pop()?.close();
});

describe("hosted provider error boundary", () => {
  it("preserves a safe provider validation response", async () => {
    const app = Fastify();
    applications.push(app);
    registerErrorHandler(app);
    app.get("/provider-validation", async () => {
      throw new HostedProviderResponseError(
        422,
        "notification_runtime_invalid",
        "The notification criterion is not supported."
      );
    });

    const response = await app.inject({ method: "GET", url: "/provider-validation" });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: {
        code: "notification_runtime_invalid",
        message: "The notification criterion is not supported."
      }
    });
  });

  it("still hides provider server failures behind the storage boundary", async () => {
    const app = Fastify();
    applications.push(app);
    registerErrorHandler(app);
    app.get("/provider-failure", async () => {
      throw new HostedProviderResponseError(
        500,
        "provider_database_failure",
        "internal provider detail"
      );
    });

    const response = await app.inject({ method: "GET", url: "/provider-failure" });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: {
        code: "hosted_provider_error",
        message: "The hosted storage provider could not complete the request."
      }
    });
  });
});
