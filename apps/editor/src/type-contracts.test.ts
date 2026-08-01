import type { CollectionContractDescriptor } from "@mdbase-dev/connect";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { NEW_TYPE_SOURCE } from "./type-constants";
import {
  addTypeContractImplementation,
  contractViewPreview,
  createTypeSourceFromContract,
  readTypeContractImplementations,
  removeTypeContractImplementation,
  setTypeContractBinding,
  setTypeContractFieldMapping,
  suggestContractsForType,
  typeFieldsForContracts,
  validateTypeContractImplementations
} from "./type-contracts";
import { readVisualType } from "./type-schema";

describe("type contract authoring", () => {
  it("creates a one-to-one type from an installed contract", () => {
    const source = createTypeSourceFromContract(NEW_TYPE_SOURCE, contactContract, ["card"]);
    const definition = readVisualType(source);
    const implementation = readTypeContractImplementations(source)[0];
    const frontmatter = parse(source.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? "");

    expect(definition.name).toBe("card-2");
    expect(definition.fields.map((field) => field.name)).toEqual(["@type", "version", "name", "emails"]);
    expect(frontmatter.schema.value.additionalProperties).toBe(true);
    expect(implementation).toMatchObject({
      contract: "standards.jscontact.card",
      version: "1.0.0",
      fields: {
        "/@type": "/@type",
        version: "version",
        name: "name",
        emails: "emails"
      }
    });
    expect(validateTypeContractImplementations(source, [contactContract])).toEqual([]);
  });

  it("suggests same-shaped contracts without claiming them", () => {
    const suggestions = suggestContractsForType(personSource, [personContract, contactContract]);

    expect(suggestions.map((suggestion) => suggestion.contract.id)).toEqual(["example.person"]);
    expect(readTypeContractImplementations(personSource)).toEqual([]);

    const next = addTypeContractImplementation(personSource, personContract);
    expect(readTypeContractImplementations(next)[0]).toMatchObject({
      contract: "example.person",
      fields: { name: "name", email: "email" }
    });
  });

  it("reports missing, unknown, and incompatible mappings before save", () => {
    const withContract = addTypeContractImplementation(personSource, personContract);
    const missing = setTypeContractFieldMapping(withContract, personContract.id, personContract.version, "name");
    expect(validateTypeContractImplementations(missing, [personContract])).toContainEqual(expect.objectContaining({
      level: "error",
      field: "name",
      message: "Map required contract field name."
    }));

    const incompatible = setTypeContractFieldMapping(missing, personContract.id, personContract.version, "name", "age");
    expect(validateTypeContractImplementations(incompatible, [personContract])).toContainEqual(expect.objectContaining({
      level: "error",
      field: "name",
      message: "name expects text, but age is an integer."
    }));

    const unknown = setTypeContractFieldMapping(incompatible, personContract.id, personContract.version, "name", "missing");
    expect(validateTypeContractImplementations(unknown, [personContract])).toContainEqual(expect.objectContaining({
      level: "error",
      message: "missing is not declared by the type schema."
    }));
  });

  it("removes an explicit implementation cleanly", () => {
    const withContract = addTypeContractImplementation(personSource, personContract);
    const removed = removeTypeContractImplementation(withContract, personContract.id, personContract.version);

    expect(readTypeContractImplementations(removed)).toEqual([]);
    expect(removed).not.toContain("implements:");
  });

  it("edits schema-driven binding settings without disturbing field mappings", () => {
    const withContract = addTypeContractImplementation(personSource, personContract);
    const next = setTypeContractBinding(withContract, personContract.id, personContract.version, {
      status: {
        completed_values: ["done", "cancelled"]
      }
    });

    expect(readTypeContractImplementations(next)[0]).toMatchObject({
      fields: { name: "name", email: "email" },
      binding: { status: { completed_values: ["done", "cancelled"] } }
    });
  });

  it("validates complete nested binding values against the contract JSON Schema", () => {
    const configurable: CollectionContractDescriptor = {
      ...personContract,
      binding_schema: {
        type: "object",
        required: ["status"],
        properties: {
          status: {
            type: "object",
            required: ["completed_values"],
            properties: {
              completed_values: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 }
              }
            }
          }
        }
      }
    };
    const withContract = addTypeContractImplementation(personSource, configurable);
    expect(validateTypeContractImplementations(withContract, [configurable])).toContainEqual(
      expect.objectContaining({ message: "Binding setting status is required by example.person." })
    );

    const empty = setTypeContractBinding(withContract, configurable.id, configurable.version, {
      status: { completed_values: [] }
    });
    expect(validateTypeContractImplementations(empty, [configurable])).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("needs at least 1 item") })
    );

    const valid = setTypeContractBinding(empty, configurable.id, configurable.version, {
      status: { completed_values: ["done", "cancelled"] }
    });
    expect(validateTypeContractImplementations(valid, [configurable])).toEqual([]);
  });

  it("previews the nested application-facing shape without transforming values", () => {
    expect(contractViewPreview({
      fields: {
        "name.full": "display_name",
        "/contact/primary_email": "/profile/email"
      }
    })).toEqual({
      name: { full: "← display_name" },
      contact: { primary_email: "← /profile/email" }
    });
  });

  it("validates a pack-installed type through its resolved referenced schema", () => {
    const source = `---
kind: mdbase.type
name: person
version: 1
schema:
  dialect: json-schema-2020-12
  ref: ../schemas/person.schema.json
implements:
  - contract: example.person
    version: 1.0.0
    fields:
      name: name
---
`;
    const resolvedSchema = {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        profile: {
          type: "object",
          required: ["email"],
          properties: { email: { type: "string", format: "email" } }
        }
      }
    };

    expect(typeFieldsForContracts(source, resolvedSchema)).toEqual([
      expect.objectContaining({ reference: "name", required: true, kind: "string" }),
      expect.objectContaining({ reference: "profile", required: false, kind: "object" }),
      expect.objectContaining({ reference: "profile.email", required: false, kind: "string" })
    ]);
    expect(validateTypeContractImplementations(source, [personContract], resolvedSchema)).toEqual([]);
  });

  it("distinguishes broader constraints from impossible mappings", () => {
    const statusContract: CollectionContractDescriptor = {
      ...personContract,
      id: "example.status",
      schema: {
        type: "object",
        required: ["status"],
        properties: {
          status: { enum: ["open", "done"] }
        }
      }
    };
    const broadSource = personSource
      .replace("name: { type: string }", "name: { type: string }\n      status: { type: string }")
      .replace("required: [name]", "required: [name, status]");
    const broad = addTypeContractImplementation(broadSource, statusContract);

    expect(validateTypeContractImplementations(broad, [statusContract])).toContainEqual(
      expect.objectContaining({
        level: "warning",
        field: "status",
        message: expect.stringContaining("allows values outside")
      })
    );

    const impossibleSource = broadSource.replace(
      "status: { type: string }",
      "status: { const: archived }"
    );
    const impossible = addTypeContractImplementation(impossibleSource, statusContract);
    expect(validateTypeContractImplementations(impossible, [statusContract])).toContainEqual(
      expect.objectContaining({
        level: "error",
        field: "status",
        message: expect.stringContaining("cannot produce a value accepted")
      })
    );
  });
});

const contactContract: CollectionContractDescriptor = {
  contract_type: "record",
  id: "standards.jscontact.card",
  version: "1.0.0",
  digest: `sha256:${"1".repeat(64)}`,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["@type", "version"],
    properties: {
      "@type": { const: "Card" },
      version: { type: "string" },
      name: {
        type: "object",
        properties: { full: { type: "string" } }
      },
      emails: {
        type: "object",
        additionalProperties: { type: "object" }
      }
    }
  },
  implementations: [{
    type_name: "contact",
    type_version: 1,
    digest: `sha256:${"2".repeat(64)}`,
    fields: { "/@type": "/card/@type", version: "card.version" }
  }]
};

const personContract: CollectionContractDescriptor = {
  contract_type: "record",
  id: "example.person",
  version: "1.0.0",
  digest: `sha256:${"3".repeat(64)}`,
  schema: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string" },
      email: { type: "string" }
    }
  },
  implementations: [{
    type_name: "legacy-person",
    type_version: 1,
    digest: `sha256:${"4".repeat(64)}`,
    fields: { name: "name" }
  }]
};

const personSource = `---
kind: mdbase.type
name: person
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      name: { type: string }
      email: { type: string }
      age: { type: integer }
    required: [name]
---
`;
