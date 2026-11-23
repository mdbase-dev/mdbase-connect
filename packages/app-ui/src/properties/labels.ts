import { plural, t } from "@lingui/core/macro";

import { dateLabels, type DateLabels } from "../DatePicker.js";

/** Every piece of text the property list shows. A host passes the ones it words differently. */
export interface PropertyLabels {
  /** A value that holds nothing. */
  empty: string;
  noProperties: string;
  addProperty: string;
  findProperty: string;
  /** Before a typed name that no property has yet. */
  newProperty: string;
  /** Before typed text that none of the offered values is. */
  useValue: string;
  showEmpty: (count: number) => string;
  hideEmpty: string;
  propertyNameInvalid: string;
  removeProperty: (name: string) => string;
  removeValue: (value: string) => string;
  clearValue: string;
  linkRecord: (property: string) => string;
  findRecord: string;
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
    findProperty: t`Find a property, or name a new one…`,
    newProperty: t`New property`,
    useValue: t({ message: "Use", context: "Before typed text, to take it as the value" }),
    showEmpty: (count) => plural(count, { one: "# empty", other: "# empty" }),
    hideEmpty: t`Hide empty`,
    propertyNameInvalid: t`Use letters, digits, - and _, starting with a letter.`,
    removeProperty: (name) => t`Remove ${name}`,
    removeValue: (value) => t`Remove ${value}`,
    clearValue: t({ message: "Clear", context: "Remove a property's value" }),
    linkRecord: (property) => t`Link a record in ${property}`,
    findRecord: t`Find a record…`,
    noMatches: t`Nothing matches.`,
    yes: t({ message: "yes", context: "A property that is true" }),
    no: t({ message: "no", context: "A property that is false" }),
    date: dateLabels(),
  };
}
