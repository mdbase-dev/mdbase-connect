import { suggestTypes, type SetupContract, type SetupType } from "@mdbase/connect-ui/contract-setup";
import type { ConfigurationProvision } from "./api";

export function initialContractSetupChoice(contract: SetupContract, types: SetupType[]): {
  mode: "starter" | "existing";
  typeName: string;
  fields: Record<string, string>;
  binding: Record<string, unknown>;
} {
  const suggestion = suggestTypes(contract, types)[0];
  return {
    mode: "starter",
    typeName: suggestion?.type.name ?? "",
    fields: suggestion?.fields ?? {},
    binding: initialSchemaValue(contract.binding_schema)
  };
}

function initialSchemaValue(schema?: Record<string, unknown>): Record<string, unknown> {
  if (!schema || !schema.properties || typeof schema.properties !== "object") return {};
  return Object.fromEntries(Object.entries(schema.properties as Record<string, unknown>).flatMap(
    ([key, candidate]) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const value = candidate as Record<string, unknown>;
      return "default" in value ? [[key, structuredClone(value.default)]] : [];
    }
  ));
}

export function configurationSetupSummary(provision: ConfigurationProvision): {
  setting: string;
  value: string;
} {
  return {
    setting: provision.path
      .split("/")
      .slice(1)
      .map(unescapeJsonPointerSegment)
      .join(" → "),
    value: typeof provision.value === "string"
      ? provision.value
      : String(provision.value)
  };
}

function unescapeJsonPointerSegment(value: string): string {
  return value.replace(/~1/g, "/").replace(/~0/g, "~");
}
