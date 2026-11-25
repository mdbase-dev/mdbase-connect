/**
 * `@mdbase-dev/ui/properties`: a record's properties, each edited in place with the control its
 * value calls for, and what the list goes by: what is declared for a property and what records
 * hold for it. Import `@mdbase-dev/ui/properties.css` and `@mdbase-dev/ui/controls.css` once.
 */
export { PropertyKindIcon, PropertyList } from "./properties/PropertyList.js";
export type { PropertyListProps } from "./properties/PropertyList.js";
export { PropertyValue } from "./properties/PropertyValue.js";
export type { PropertyLinkCreation, PropertyRecord, PropertyRecords, PropertyValueProps } from "./properties/PropertyValue.js";
export { propertyLabels } from "./properties/labels.js";
export type { PropertyLabels } from "./properties/labels.js";
export {
  blankValue, describeProperty, filterFieldsFromProperties, inferProperty, isEmptyValue, isPropertyName, linkLabel, linkToPath, parseValue, pathToLink,
  propertiesInUse, propertyKind, valueLine,
} from "./properties/model.js";
export type { PropertyInfo, PropertyKind, PropertyScalar } from "./properties/model.js";
export { mergeTypeSchemas, propertiesFromSchema } from "./properties/schema.js";
export type { JsonSchema } from "./properties/schema.js";
