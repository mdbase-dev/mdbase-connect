import { describe, expect, it } from "vitest";
import {
  apiError,
  httpErrorStatus,
  oauthError
} from "./http-errors.js";

describe("HTTP error contracts", () => {
  it("keeps API and OAuth errors structurally distinct", () => {
    expect(apiError("invalid_request", "Invalid request.")).toEqual({
      error: {
        code: "invalid_request",
        message: "Invalid request."
      }
    });
    expect(oauthError("invalid_grant", "Grant expired.")).toEqual({
      error: "invalid_grant",
      error_description: "Grant expired."
    });
  });

  it("accepts only numeric status codes from unknown errors", () => {
    expect(httpErrorStatus({ statusCode: 413 })).toBe(413);
    expect(httpErrorStatus({ statusCode: "413" })).toBeUndefined();
    expect(httpErrorStatus(null)).toBeUndefined();
  });
});
