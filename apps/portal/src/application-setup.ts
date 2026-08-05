import type { ConfigurationProvision } from "./api";

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
