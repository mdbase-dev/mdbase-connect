import { expect, it, vi } from "vitest";
import { api, ApiError } from "./api";
import { message } from "./portal-model";

it("preserves the typed refusal and displays readable copy for code-only API errors", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: {
    code: "account_changed", message: "account_changed", details: { diagnostics: [{ message: "account_id_mismatch" }] }
  } }, { status: 409 }));
  const request = api("/v1/test");
  await expect(request).rejects.toMatchObject({ status: 409, code: "account_changed" });
  const error = await request.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(ApiError);
  expect(message(error)).toBe("Something went wrong on mdbase. Try again.");
});
