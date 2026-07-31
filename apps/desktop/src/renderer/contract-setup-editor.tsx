import {
  assessMapping,
  contractFields,
  guidedBindingSupported,
  propertyFields,
  setupLabel,
  suggestTypes,
  typeFields,
  type SetupContract,
  type SetupType
} from "@mdbase/connect-ui/contract-setup";
import React, { useMemo } from "react";

export interface ContractSetupChoice {
  mode: "starter" | "existing";
  typeName: string;
  fields: Record<string, string>;
  binding: Record<string, unknown>;
}

export function initialContractSetupChoice(
  contract: SetupContract,
  types: SetupType[]
): ContractSetupChoice {
  const suggestion = suggestTypes(contract, types)[0];
  return {
    mode: "starter",
    typeName: suggestion?.type.name ?? "",
    fields: suggestion?.fields ?? {},
    binding: initialSchemaValue(contract.binding_schema)
  };
}

export function ContractSetupEditor({
  applicationName,
  contract,
  types,
  value,
  disabled,
  onChange
}: {
  applicationName: string;
  contract: SetupContract;
  types: SetupType[];
  value: ContractSetupChoice;
  disabled: boolean;
  onChange(value: ContractSetupChoice): void;
}) {
  const suggestions = useMemo(() => suggestTypes(contract, types), [contract, types]);
  const canGuideExistingType = guidedBindingSupported(contract);
  const selectedType = types.find((type) => type.name === value.typeName);
  const availableFields = selectedType ? typeFields(selectedType) : [];
  const fields = contractFields(contract);
  const bindingFields = contract.binding_schema ? propertyFields(contract.binding_schema) : [];
  const requiredBinding = new Set(
    Array.isArray(contract.binding_schema?.required)
      ? contract.binding_schema.required.filter((field): field is string => typeof field === "string")
      : []
  );

  function selectType(typeName: string) {
    const suggestion = suggestions.find((candidate) => candidate.type.name === typeName);
    onChange({ ...value, typeName, fields: suggestion?.fields ?? {} });
  }

  return <div className="contract-setup-editor">
    <div className="contract-setup-heading">
      <div>
        <strong>Help {applicationName} understand {setupLabel(contract).toLocaleLowerCase()}</strong>
        <small>{contract.description ?? "Add the application’s starter type or use one of your existing types."}</small>
      </div>
      <code>{contract.id} · {contract.version}</code>
    </div>
    <div className="contract-setup-mode" role="radiogroup" aria-label={`Setup for ${setupLabel(contract)}`}>
      <label className={value.mode === "starter" ? "selected" : undefined}>
        <input type="radio" name={`setup-${contract.id}-${contract.version}`} checked={value.mode === "starter"} disabled={disabled} onChange={() => onChange({ ...value, mode: "starter" })} />
        <span><strong>Add {applicationName}’s starter type</strong><small>Create a separate type supplied by the application.</small></span>
      </label>
      {suggestions.length > 0 && canGuideExistingType && <label className={value.mode === "existing" ? "selected" : undefined}>
        <input type="radio" name={`setup-${contract.id}-${contract.version}`} checked={value.mode === "existing"} disabled={disabled} onChange={() => onChange({ ...value, mode: "existing" })} />
        <span><strong>Use an existing type</strong><small>Explain which fields mean the same thing.</small></span>
      </label>}
    </div>
    {!canGuideExistingType && suggestions.length > 0 && <small>This contract has advanced behavior settings. Add its starter type here, or connect an existing type later in mdbase editor.</small>}
    {value.mode === "existing" && canGuideExistingType && <div className="contract-mapping">
      <label className="contract-type-choice"><span>Existing type</span><select value={value.typeName} disabled={disabled} onChange={(event) => selectType(event.target.value)}>
        {suggestions.map((suggestion, index) => <option value={suggestion.type.name} key={suggestion.type.name}>{suggestion.type.name}{index === 0 && suggestion.requiredMatched === suggestion.requiredTotal ? " · suggested" : ""}</option>)}
      </select></label>
      <div className="contract-field-list">{fields.map((field) => {
        const mapped = value.fields[field.reference] ?? "";
        const typeField = availableFields.find((candidate) => candidate.reference === mapped);
        const assessment = assessMapping(field, typeField);
        return <label key={field.reference}>
          <span><strong>{field.label}{field.required ? " *" : ""}</strong><small>{field.description ?? `The application’s ${field.label.toLocaleLowerCase()} value.`}</small></span>
          <select value={mapped} disabled={disabled} aria-invalid={assessment.level === "error"} onChange={(event) => {
            const next = { ...value.fields };
            if (event.target.value) next[field.reference] = event.target.value;
            else delete next[field.reference];
            onChange({ ...value, fields: next });
          }}>
            <option value="">{field.required ? "Choose a field" : "Do not share"}</option>
            {availableFields.map((candidate) => <option key={candidate.reference} value={candidate.reference}>{candidate.label}</option>)}
          </select>
          <small className={`mapping-assessment ${assessment.level}`}>{assessment.label} · {assessment.message}</small>
        </label>;
      })}</div>
      {bindingFields.length > 0 && <fieldset className="contract-binding">
        <legend>How this type behaves in {applicationName}</legend>
        {bindingFields.map((field) => <ContractBindingInput
          key={field.name}
          field={field}
          required={requiredBinding.has(field.name)}
          value={value.binding[field.name]}
          disabled={disabled}
          onChange={(next) => onChange({ ...value, binding: { ...value.binding, [field.name]: next } })}
        />)}
      </fieldset>}
      <small>Only this type definition changes. Existing records stay in place. Setup is validated before access becomes active.</small>
    </div>}
  </div>;
}

function ContractBindingInput({ field, required, value, disabled, onChange }: {
  field: ReturnType<typeof propertyFields>[number];
  required: boolean;
  value: unknown;
  disabled: boolean;
  onChange(value: unknown): void;
}) {
  const options = Array.isArray(field.schema.enum) ? field.schema.enum : undefined;
  return <label>
    <span>{field.label}{required ? " *" : ""}</span>
    {options ? <select value={value === undefined ? "" : String(value)} disabled={disabled} onChange={(event) => onChange(options.find((option) => String(option) === event.target.value))}>
      <option value="">Choose</option>
      {options.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}
    </select> : field.kind === "boolean" ? <input type="checkbox" checked={value === true} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /> : <input
      type={field.kind === "number" || field.kind === "integer" ? "number" : "text"}
      value={typeof value === "string" || typeof value === "number" ? value : ""}
      disabled={disabled}
      onChange={(event) => onChange(field.kind === "number" || field.kind === "integer" ? event.target.value === "" ? undefined : Number(event.target.value) : event.target.value)}
    />}
    {field.description && <small>{field.description}</small>}
  </label>;
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
