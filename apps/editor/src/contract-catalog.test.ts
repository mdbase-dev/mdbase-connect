import { describe, expect, it, vi } from "vitest";
import {
  contractCatalogPackStatus,
  loadContractCatalog,
  loadTypePackProvision,
  parseTypePackProvision,
  parseContractCatalog
} from "./contract-catalog";

const digest = `sha256:${"a".repeat(64)}`;
const catalogDocument = {
  catalog_version: 2,
  id: "dev.mdbase.first-party",
  name: "mdbase contracts",
  description: "Portable contracts.",
  homepage: "https://mdbase.dev/contracts/",
  publisher: { name: "mdbase", url: "https://mdbase.dev/" },
  contracts: [{
    id: "mdbase.contact",
    version: "1.0.0",
    name: "Contact",
    description: "A contact.",
    contract_type: "record",
    digest,
    artifact: "./artifacts/contact.md",
    standards: []
  }],
  packs: [{
    id: "mdbase.contacts",
    version: "1.0.0",
    name: "Contacts",
    description: "Contact contract and type.",
    digest,
    provision: "./packs/contacts.json",
    provides: [{ id: "mdbase.contact", version: "1.0.0" }],
    resource_count: 2,
    display: {
      name: "Contact",
      summary: "Store people and organisations.",
      category: "people",
      audience: "general",
      icon: "address-book",
      badges: ["JSContact 2.0"]
    },
    installation: {
      visibility: "default",
      recommendation: "user",
      primary_type: "contact",
      types: [{ name: "contact", label: "Contact" }]
    }
  }]
};

describe("contract catalog", () => {
  it("loads the catalog and resolves publication-relative artifacts", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(catalogDocument), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    const catalog = await loadContractCatalog({
      url: "https://mdbase.dev/contracts/catalog.json",
      fetcher
    });

    expect(fetcher).toHaveBeenCalledWith(
      "https://mdbase.dev/contracts/catalog.json",
      expect.objectContaining({
        headers: { Accept: "application/json" },
        cache: "no-store"
      })
    );
    expect(catalog.contracts[0]?.artifactUrl)
      .toBe("https://mdbase.dev/contracts/artifacts/contact.md");
    expect(catalog.packs[0]?.provisionUrl)
      .toBe("https://mdbase.dev/contracts/packs/contacts.json");
    expect(catalog.packs[0]).toMatchObject({
      displayName: "Contact",
      primaryType: "contact",
      visibility: "default"
    });
  });

  it("rejects unsupported catalogs and unsafe artifact protocols", () => {
    expect(() => parseContractCatalog(
      { ...catalogDocument, catalog_version: 3 },
      "https://mdbase.dev/contracts/catalog.json"
    )).toThrow("unsupported version");
    expect(() => parseContractCatalog({
      ...catalogDocument,
      packs: [{ ...catalogDocument.packs[0], provision: "javascript:alert(1)" }]
    }, "https://mdbase.dev/contracts/catalog.json")).toThrow("HTTP or HTTPS");
  });

  it("distinguishes available, partial, and installed packs", () => {
    const catalog = parseContractCatalog({
      ...catalogDocument,
      packs: [{
        ...catalogDocument.packs[0],
        provides: [
          { id: "mdbase.contact", version: "1.0.0" },
          { id: "mdbase.person", version: "1.0.0" }
        ]
      }]
    }, "https://mdbase.dev/contracts/catalog.json");
    const pack = catalog.packs[0]!;

    expect(contractCatalogPackStatus(pack, [])).toBe("available");
    expect(contractCatalogPackStatus(
      pack,
      [{ id: "mdbase.contact", version: "1.0.0" }]
    ))
      .toBe("partial");
    expect(contractCatalogPackStatus(pack, pack.provides, [{ name: "contact" }]))
      .toBe("installed");
  });

  it("keeps catalog v1 packs readable with conservative presentation defaults", () => {
    const legacy = parseContractCatalog({
      ...catalogDocument,
      catalog_version: 1,
      packs: [{
        id: "mdbase.contacts",
        version: "1.0.0",
        name: "Contacts",
        description: "Contact contract and type.",
        digest,
        provision: "./packs/contacts.json",
        provides: [{ id: "mdbase.contact", version: "1.0.0" }],
        resource_count: 2,
        featured: true
      }]
    }, "https://mdbase.dev/contracts/catalog.json");

    expect(legacy.packs[0]).toMatchObject({
      displayName: "Contacts",
      visibility: "default",
      recommendation: "optional",
      installedTypes: []
    });
  });

  it("loads a catalog pack only when its bytes and declared resources match", async () => {
    const pack = parseContractCatalog(
      catalogDocument,
      "https://mdbase.dev/contracts/catalog.json"
    ).packs[0]!;
    const provision = {
      manifest: {
        kind: "mdbase.type-pack",
        id: pack.id,
        version: pack.version,
        resources: [
          {
            kind: "contract",
            source: "contracts/contact.md",
            target: "_contracts/contact.md",
            digest
          },
          {
            kind: "type",
            source: "types/contact.md",
            target: "_types/contact.md",
            digest
          }
        ]
      },
      resources: [
        { source: "contracts/contact.md", document: "contract" },
        { source: "types/contact.md", document: "type" }
      ],
      provides: pack.provides
    };
    const document = JSON.stringify(provision);
    const expectedPack = {
      ...pack,
      digest: await sha256(document)
    };
    const fetcher = vi.fn(async () => new Response(document, { status: 200 }));

    await expect(loadTypePackProvision(expectedPack, { fetcher })).resolves.toEqual(provision);
    expect(fetcher).toHaveBeenCalledWith(
      pack.provisionUrl,
      expect.objectContaining({ headers: { Accept: "application/json" } })
    );
  });

  it("rejects changed pack bytes and unsafe resource targets", async () => {
    const pack = parseContractCatalog(
      catalogDocument,
      "https://mdbase.dev/contracts/catalog.json"
    ).packs[0]!;
    await expect(loadTypePackProvision(pack, {
      fetcher: vi.fn(async () => new Response("{}", { status: 200 }))
    })).rejects.toThrow("catalog digest");

    expect(() => parseTypePackProvision({
      manifest: {
        kind: "mdbase.type-pack",
        id: pack.id,
        version: pack.version,
        resources: [
          {
            kind: "contract",
            source: "contracts/contact.md",
            target: "../outside.md",
            digest
          },
          {
            kind: "type",
            source: "types/contact.md",
            target: "_types/contact.md",
            digest
          }
        ]
      },
      resources: [
        { source: "contracts/contact.md", document: "contract" },
        { source: "types/contact.md", document: "type" }
      ],
      provides: pack.provides
    }, pack)).toThrow("inside the collection");
  });
});

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
