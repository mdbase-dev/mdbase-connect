import { plural, t } from "@lingui/core/macro";

import { dateLabels, type DateLabels } from "../DatePicker.js";

/** Every piece of text the property list shows. A host passes the ones it words differently. */
export interface PropertyLabels {
  /** A value that holds nothing. */
  empty: string;
  noProperties: string;
  addProperty: string;
  /** Adding a part to a value that has parts, which is named. */
  addPropertyTo: (property: string) => string;
  findProperty: string;
  /** In a value that takes only the parts its type names. */
  findDeclaredProperty: string;
  /** Before a typed name that no property has yet. */
  newProperty: string;
  /** Before typed text that none of the offered values is. */
  useValue: string;
  showEmpty: (count: number) => string;
  hideEmpty: string;
  propertyNameInvalid: string;
  removeProperty: (name: string) => string;
  removeValue: (value: string) => string;
  /** Beside a property the record is not valid without. */
  required: string;
  /** How many parts a value with parts holds. */
  partCount: (count: number) => string;
  /** How many values a list holds. */
  itemCount: (count: number) => string;
  addItem: string;
  addItemTo: (property: string) => string;
  removeItem: (property: string, place: number) => string;
  /** Says whose clock a date and time is in. */
  localTime: (zone: string) => string;
  clearValue: string;
  linkRecord: (property: string) => string;
  findRecord: string;
  /** A way to make a record from what was typed: the kind of record, then its title. */
  createRecord: (kind: string, title: string) => string;
  noMatches: string;
  /** A true or false value where it is only shown. */
  yes: string;
  no: string;
  /** The date picker's text. */
  date: DateLabels;
}

/** The property list's text in the current language. */
export function propertyLabels(): PropertyLabels {
  return {
    empty: t({ message: "Empty", context: "A property with no value" }),
    noProperties: t({ message: "No properties.", context: "Property list" }),
    addProperty: t({ message: "Add property", context: "Property list" }),
    addPropertyTo: (property) => t({ message: `Add property to ${property}`, context: "Property list" }),
    findProperty: t({ message: "Find a property, or name a new one…", context: "Property list" }),
    findDeclaredProperty: t({ message: "Find a property…", context: "Property list" }),
    newProperty: t({ message: "New property", context: "Property list" }),
    useValue: t({ message: "Use", context: "Before typed text, to take it as the value" }),
    showEmpty: (count) => t({ message: plural(count, { one: "# empty", other: "# empty" }), context: "Property list" }),
    hideEmpty: t({ message: "Hide empty", context: "Property list" }),
    propertyNameInvalid: t({ message: "Use letters, digits, - and _, starting with a letter.", context: "Property list" }),
    removeProperty: (name) => t({ message: `Remove ${name}`, context: "Property list" }),
    removeValue: (value) => t({ message: `Remove ${value}`, context: "Property list" }),
    required: t({ message: "Required", context: "A property a record must have" }),
    partCount: (count) => t({ message: plural(count, { one: "# property", other: "# properties" }), context: "Property list" }),
    itemCount: (count) => t({ message: plural(count, { one: "# item", other: "# items" }), context: "Property list" }),
    addItem: t({ message: "Add item", context: "Property list" }),
    addItemTo: (property) => t({ message: `Add item to ${property}`, context: "Property list" }),
    removeItem: (property, place) => t({ message: `Remove item ${place} from ${property}`, context: "Property list" }),
    localTime: (zone) => t({ message: `Local time (${zone})`, context: "Property list" }),
    clearValue: t({ message: "Clear", context: "Remove a property's value" }),
    linkRecord: (property) => t({ message: `Link a record in ${property}`, context: "Property list" }),
    findRecord: t({ message: "Find a record…", context: "Property list" }),
    createRecord: (kind, title) => t({ message: `${kind} “${title}”`, context: "Property list" }),
    noMatches: t({ message: "Nothing matches.", context: "Property list" }),
    yes: t({ message: "yes", context: "A property that is true" }),
    no: t({ message: "no", context: "A property that is false" }),
    date: dateLabels(),
  };
}
