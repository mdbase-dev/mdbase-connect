import { describe, expect, it, vi } from "vitest";
import { connectError } from "./errors.js";
import { MdbasePeopleClient } from "./people-client.js";

const account = { issuer: "https://connect.example", subject: "usr_123", name: "Callum" };
describe("people discovery", () => {
  it("returns exact issuer/subject values and strips unrelated account fields", async () => {
    const request = vi.fn().mockResolvedValue({ ...account, issuer: account.issuer + "/", email: "private@example.com" });
    const client = new MdbasePeopleClient(request);
    expect(await client.current()).toMatchObject({ ok: true, value: { ...account, issuer: account.issuer + "/" } });
    expect((await client.current())).not.toHaveProperty("value.email");
    expect(request).toHaveBeenCalledWith("identity", undefined);
  });
  it("returns members without granting permission to manage them", async () => {
    const client = new MdbasePeopleClient(async () => ({ members: [{ ...account, role: "viewer" }] }));
    expect(await client.members()).toMatchObject({ ok: true, value: [{ ...account, role: "viewer" }] });
  });
  it("distinguishes unsupported, denied and unavailable from an empty directory", async () => {
    for (const code of ["unsupported_operation", "access_denied", "temporarily_unavailable"] as const) {
      const client = new MdbasePeopleClient(async () => { throw connectError(code, "Fixture"); });
      expect(await client.current()).toMatchObject({ ok: false, problem: { code } });
      expect(await client.members()).toMatchObject({ ok: false, problem: { code } });
    }
  });
  it("rejects malformed profiles and directory roles", async () => {
    for (const value of [null, {}, { ...account, subject: "" }, { ...account, issuer: "/relative" }, { ...account, name: 5 }]) {
      const client = new MdbasePeopleClient(async () => value);
      expect(await client.current()).toMatchObject({ ok: false, problem: { code: "invalid_operation_response" } });
    }
    for (const value of [{}, { members: [{ ...account, role: "administrator" }] }, { members: null }]) {
      const client = new MdbasePeopleClient(async () => value);
      expect(await client.members()).toMatchObject({ ok: false, problem: { code: "invalid_operation_response" } });
    }
  });
  it("passes cancellation options through", async () => {
    const request = vi.fn().mockResolvedValue(account);
    const options = { signal: new AbortController().signal };
    await new MdbasePeopleClient(request).current(options);
    expect(request).toHaveBeenCalledWith("identity", options);
  });
});
