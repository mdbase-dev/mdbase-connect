import { describe, expect, it, vi } from "vitest";
import { connectError } from "./errors.js";
import { connectFailure, connectSuccess } from "./outcomes.js";
import { MdbasePeopleClient, type PeopleClientContext } from "./people-client.js";

const account = { issuer: "https://id.example", subject: "acct_123", name: "Callum" };
const other = { issuer: "https://id.example", subject: "acct_456", name: "Alex" };
const me = { issuer: account.issuer, subject: account.subject };

function client(options: {
  identity?: unknown;
  members?: unknown;
  types?: string[];
  records?: Record<string, Array<{ path: string; frontmatter: Record<string, unknown> }>>;
  pages?: number;
} = {}) {
  const types = options.types ?? ["person"];
  const request = vi.fn(async (resource: "identity" | "members") => {
    const value = resource === "identity"
      ? ("identity" in options ? options.identity : account)
      : ("members" in options ? options.members : { members: [{ ...account, role: "owner" }] });
    if (value instanceof Error) throw value;
    return value;
  });
  const queryPages = vi.fn(async function* (input: { contract?: { type?: string } }) {
    const records = options.records?.[input.contract?.type ?? ""] ?? [];
    const size = Math.ceil(records.length / (options.pages ?? 1)) || 1;
    for (let offset = 0; offset < Math.max(records.length, 1); offset += size) {
      yield connectSuccess({ results: records.slice(offset, offset + size), page: 0, offset, loaded: offset + size, complete: offset + size >= records.length });
    }
  });
  const context = {
    request,
    describe: async () => connectSuccess({
      contracts: [{ id: "mdbase.person", version: "2.0.0", implementations: types.map((typeName) => ({ typeName, fields: {} })) }]
    }),
    queryPages
  } as unknown as PeopleClientContext;
  return { people: new MdbasePeopleClient(context), request, queryPages };
}

const person = (path: string, identities: unknown[] = [], name = path) =>
  ({ path, frontmatter: { name, identities } });

describe("people account discovery", () => {
  it("returns exact identity values, the settings route, and strips unrelated fields", async () => {
    const url = "https://editor.example/?collection=c&surface=settings#your-person";
    const { people } = client({ identity: { ...account, issuer: account.issuer + "/", email: "private@example.com", person_settings_url: url } });
    const current = await people.current();
    expect(current.ok && current.value).toEqual({ ...account, issuer: account.issuer + "/", personSettingsUrl: url });
  });

  it("distinguishes unsupported, denied and unavailable from an empty directory", async () => {
    for (const code of ["unsupported_operation", "access_denied", "temporarily_unavailable"] as const) {
      const { people } = client({ identity: connectError(code, "Fixture"), members: connectError(code, "Fixture") });
      expect(await people.current()).toMatchObject({ ok: false, problem: { code } });
      expect(await people.members()).toMatchObject({ ok: false, problem: { code } });
      expect(await people.directory()).toMatchObject({ ok: false, problem: { code } });
    }
  });

  it("rejects malformed profiles, settings routes and directory roles", async () => {
    for (const identity of [null, {}, { ...account, subject: "" }, { ...account, issuer: "/relative" }, { ...account, name: 5 },
      { ...account, person_settings_url: "javascript:alert(1)" }]) {
      expect(await client({ identity }).people.current()).toMatchObject({ ok: false, problem: { code: "invalid_operation_response" } });
    }
    for (const members of [{}, { members: [{ ...account, role: "administrator" }] }, { members: null }]) {
      expect(await client({ members }).people.members()).toMatchObject({ ok: false, problem: { code: "invalid_operation_response" } });
    }
  });
});

describe("person directory", () => {
  it("links the one record claiming this account across implementations and pages", async () => {
    const { people, queryPages } = client({
      types: ["person", "contact"], pages: 3,
      records: {
        person: [person("people/alex.md", [other]), person("people/callum.md", [me])],
        contact: [person("contacts/sam.md"), person("contacts/jo.md"), person("contacts/kim.md")]
      }
    });
    const directory = await people.directory();
    if (!directory.ok) throw new Error(directory.problem.message);
    expect(directory.value.me).toEqual({ status: "linked", person: expect.objectContaining({ path: "people/callum.md", typeNames: ["person"] }) });
    expect(directory.value.people.map((record) => record.path)).toEqual(["contacts/jo.md", "contacts/kim.md", "contacts/sam.md", "people/alex.md", "people/callum.md"]);
    expect(directory.value.members).toEqual([{ ...account, role: "owner" }]);
    expect(queryPages).toHaveBeenCalledWith({ contract: { id: "mdbase.person", version: "2.0.0", type: "contact" } }, expect.anything());
  });

  it("matches exactly and reports unlinked without guessing by name or normalized issuer", async () => {
    const { people } = client({ records: { person: [
      person("a.md", [{ issuer: account.issuer + "/", subject: account.subject }], "Callum"),
      person("b.md", [{ issuer: account.issuer, subject: account.subject.toUpperCase() }])
    ] } });
    const directory = await people.directory();
    expect(directory.ok && directory.value.me).toEqual({ status: "unlinked" });
  });

  it("treats several records claiming the account as ambiguous", async () => {
    const several = await client({ records: { person: [person("a.md", [me]), person("b.md", [me]), person("c.md")] } }).people.directory();
    expect(several.ok && several.value.me).toEqual({ status: "ambiguous", paths: ["a.md", "b.md"] });
  });

  it("reports invalid records without failing the directory, unless they claim this account", async () => {
    const unrelated = await client({ records: { person: [person("bad.md", [], " "), person("me.md", [me])] } }).people.directory();
    expect(unrelated.ok && unrelated.value.me).toMatchObject({ status: "linked" });
    expect(unrelated.ok && unrelated.value.invalid).toEqual([{ path: "bad.md", reason: "It needs a non-blank name." }]);
    const claiming = await client({ records: { person: [person("bad.md", [me], ""), person("me.md", [me])] } }).people.directory();
    expect(claiming.ok && claiming.value.me).toEqual({ status: "invalid", paths: ["bad.md"] });
  });

  it("reports a record whose implementations project different values", async () => {
    const { people } = client({ types: ["person", "contact"], records: {
      person: [person("x.md", [me], "One")], contact: [person("x.md", [me], "Two")]
    } });
    const directory = await people.directory();
    expect(directory.ok && directory.value.invalid).toEqual([{ path: "x.md", reason: "Its Person implementations project different values." }]);
    expect(directory.ok && directory.value.me).toEqual({ status: "invalid", paths: ["x.md"] });
  });

  it("omits members only when that optional permission was declined", async () => {
    const declined = await client({ members: connectError("access_denied", "Declined"), records: { person: [] } }).people.directory();
    expect(declined.ok && declined.value).not.toHaveProperty("members");
    const required = await client({ members: connectError("access_denied", "Declined") }).people.directory({ members: "require" });
    expect(required).toMatchObject({ ok: false, problem: { code: "access_denied" } });
    const { people, request } = client();
    await people.directory({ members: "omit" });
    expect(request).not.toHaveBeenCalledWith("members", expect.anything());
  });

  it("fails rather than returning a partial directory when a page fails", async () => {
    const { people, queryPages } = client();
    queryPages.mockImplementation(async function* () {
      yield connectFailure({ code: "temporarily_unavailable", message: "Page failed", category: "availability", recovery: "retry" } as never);
    });
    expect(await people.directory()).toMatchObject({ ok: false, problem: { code: "temporarily_unavailable" } });
  });
});
