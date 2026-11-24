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
    noProperties: t`No properties.`,
    addProperty: t`Add property`,
    addPropertyTo: (property) => t`Add property to ${property}`,
    findProperty: t`Find a property, or name a new one…`,
    findDeclaredProperty: t`Find a property…`,
    newProperty: t`New property`,
    useValue: t({ message: "Use", context: "Before typed text, to take it as the value" }),
    showEmpty: (count) => plural(count, { one: "# empty", other: "# empty" }),
    hideEmpty: t`Hide empty`,
    propertyNameInvalid: t`Use letters, digits, - and _, starting with a letter.`,
    removeProperty: (name) => t`Remove ${name}`,
    removeValue: (value) => t`Remove ${value}`,
    required: t({ message: "Required", context: "A property a record must have" }),
    partCount: (count) => plural(count, { one: "# property", other: "# properties" }),
    itemCount: (count) => plural(count, { one: "# item", other: "# items" }),
    addItem: t`Add item`,
    addItemTo: (property) => t`Add item to ${property}`,
    removeItem: (property, place) => t`Remove item ${place} from ${property}`,
    localTime: (zone) => t`Local time (${zone})`,
    clearValue: t({ message: "Clear", context: "Remove a property's value" }),
    linkRecord: (property) => t`Link a record in ${property}`,
    findRecord: t`Find a record…`,
    createRecord: (kind, title) => t`${kind} “${title}”`,
    noMatches: t`Nothing matches.`,
    yes: t({ message: "yes", context: "A property that is true" }),
    no: t({ message: "no", context: "A property that is false" }),
    date: dateLabels(),
  };
}
