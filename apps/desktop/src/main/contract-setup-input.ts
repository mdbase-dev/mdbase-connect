export function contractSetupInput(value: unknown): Array<Record<string, unknown>> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error("Invalid contract setup.");
  }
  return value.map((candidate) => {
    const setup = asObject(candidate, "Invalid contract setup.");
    const contract = asObject(setup.contract, "Invalid contract setup.");
    if (
      typeof contract.id !== "string"
      || typeof contract.version !== "string"
      || contract.id.length === 0
      || contract.version.length === 0
      || (setup.mode !== "starter" && setup.mode !== "existing")
    ) {
      throw new Error("Invalid contract setup.");
    }
    if (setup.mode === "starter") {
      return {
        contract: { id: contract.id, version: contract.version },
        mode: "starter"
      };
    }
    const fields = asObject(setup.fields, "Invalid contract field mappings.");
    if (
      typeof setup.type_name !== "string"
      || setup.type_name.length === 0
      || setup.type_name.length > 100
      || typeof setup.type_revision !== "string"
      || !/^sha256:[0-9a-f]{64}$/.test(setup.type_revision)
      || Object.keys(fields).length > 100
      || Object.entries(fields).some(([contractField, typeField]) =>
        contractField.length === 0
        || contractField.length > 500
        || typeof typeField !== "string"
        || typeField.length === 0
        || typeField.length > 500
      )
    ) {
      throw new Error("Invalid contract setup.");
    }
    return {
      contract: { id: contract.id, version: contract.version },
      mode: "existing",
      type_name: setup.type_name,
      type_revision: setup.type_revision,
      fields,
      ...(setup.binding === undefined
        ? {}
        : { binding: asObject(setup.binding, "Invalid contract binding.") })
    };
  });
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}
