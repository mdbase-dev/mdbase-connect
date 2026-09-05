import { describe, expect, it } from "vitest";
import { APPLICATION_DECLARATION_EVIDENCE_CAPABILITY, CONNECT_CONTRACT_SUPPORT,
  authorizationContractRequirements } from "@mdbase-dev/connect-protocol";
import { RelayHub } from "./relay.js";

function fixture() {
  const hub = Object.create(RelayHub.prototype) as RelayHub;
  const sessions = new Map<string, any>();
  Object.assign(hub, { connectors: sessions, closed: false,
    currentGeneration: async (id: string) => sessions.get(id)?.generation ?? null });
  const current = () => ({ ready: true, generation: "1", socket: { readyState: 1 },
    capabilities: [APPLICATION_DECLARATION_EVIDENCE_CAPABILITY],
    contractSupport: structuredClone(CONNECT_CONTRACT_SUPPORT) });
  sessions.set("selected", current());
  sessions.set("other", current());
  return { hub, sessions };
}
const v2 = authorizationContractRequirements(["read"]);
const v1 = authorizationContractRequirements(["read"], undefined, [], 1);

describe("exact selected local authority", () => {
  it("requires both semantic and declaration evidence support, not some other connector", () => {
    const { hub, sessions } = fixture();
    expect(hub.supportsContracts("selected", v2)).toBe(true);
    sessions.get("selected").capabilities = [];
    expect(hub.supportsContracts("selected", v2)).toBe(false);
    expect(hub.supportsContracts("selected", v1)).toBe(true);
    sessions.get("selected").contractSupport.semantic_capabilities = [1];
    expect(hub.supportsContracts("selected", v2)).toBe(false);
    sessions.get("selected").socket.readyState = 3;
    expect(hub.supportsContracts("selected", v1)).toBe(false);
    sessions.delete("selected");
    expect(hub.supportsContracts("selected", v2)).toBe(false);
    expect(hub.supportsContracts("other", v2)).toBe(true);
  });
  it("gates immediate activation evidence and refuses v2 on an old authority", async () => {
    const { hub, sessions } = fixture();
    const messages: any[] = [];
    Object.assign(hub, { deliver: async (_id: string, _generation: string, message: unknown) => {
      messages.push(message);
      return { ok: true };
    } });
    const input: any = { authorityGeneration: "1", authorizationId: "pending", grant: {
      application_declaration: { retained: "complete" },
      application_authorization: { binding: { contracts: v1 } }
    } };
    sessions.get("selected").capabilities = [];
    sessions.get("selected").contractSupport.semantic_capabilities = [1];
    await hub.activateAuthorization("selected", input);
    expect(messages[0].grant).not.toHaveProperty("application_declaration");
    expect(messages[0].grant.application_authorization.binding.contracts).toEqual(v1);
    input.grant.application_authorization.binding.contracts = v2;
    await expect(hub.activateAuthorization("selected", input)).rejects.toThrow();
    expect(messages).toHaveLength(1);
    sessions.get("selected").capabilities = [APPLICATION_DECLARATION_EVIDENCE_CAPABILITY];
    sessions.get("selected").contractSupport.semantic_capabilities = [2, 1];
    await hub.activateAuthorization("selected", input);
    expect(messages[1].grant.application_declaration).toEqual({ retained: "complete" });
  });
  it("rejects a generation switch or capability loss between approval and publication", async () => {
    const { hub, sessions } = fixture();
    const selected = hub.authorizationAuthority("selected", v2);
    await expect(hub.assertAuthorizationAuthority("selected", selected, v2)).resolves.toBeUndefined();
    sessions.get("selected").generation = "2";
    await expect(hub.assertAuthorizationAuthority("selected", selected, v2)).rejects.toThrow();
    sessions.get("selected").generation = selected;
    sessions.get("selected").contractSupport.semantic_capabilities = [1];
    await expect(hub.assertAuthorizationAuthority("selected", selected, v2)).rejects.toThrow();
  });
});
