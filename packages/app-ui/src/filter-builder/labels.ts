import { plural, t } from "@lingui/core/macro";

import { dateLabels, type DateLabels } from "../DatePicker.js";

/** Every piece of text the filter builder shows. A host passes the ones it words differently. */
export interface FilterLabels {
  /** The bar's accessible name, unless `ariaLabel` is given. */
  filters: string;
  filter: string;
  addFilter: string;
  match: string;
  matchAll: string;
  matchAny: string;
  exclude: string;
  howFiltersCombine: string;
  all: string;
  any: string;
  none: string;
  everyFilter: string;
  atLeastOne: string;
  noFilter: string;
  howTheseCombine: string;
  /** A nested group's accessible name, from its combinator's name. */
  group: (name: string) => string;
  addFilterToGroup: string;
  addFilterToGroupHint: string;
  removeGroup: string;
  shared: string;
  sharedHint: string;
  /** A shared filter's accessible name. */
  sharedName: (name: string) => string;
  filterOptions: string;
  editAsExpression: string;
  convertToPill: string;
  wrapInOrGroup: string;
  moveToShared: string;
  moveToSharedHint: string;
  moveToView: string;
  remove: string;
  removeFilter: string;
  /** Why a filter on a field the host owns cannot be removed. */
  lockedField: (field: string) => string;
  operator: string;
  changeOperator: string;
  chooseValue: string;
  editValue: string;
  /** An expression pill's accessible name; `text` is empty for a blank one. */
  expressionName: (text: string) => string;
  expression: string;
  editExpression: string;
  celExpression: string;
  celHint: string;
  apply: string;
  customExpression: string;
  filterGroup: string;
  filterGroupHint: string;
  back: string;
  filterByField: string;
  filterByPlaceholder: string;
  fields: string;
  noMatchingFields: string;
  scope: string;
  thisView: string;
  /** Names the `this.*` values offered beside a typed one. */
  contextValues: string;
  compareWith: (expr: string) => string;
  values: string;
  noValues: string;
  addValue: string;
  addValuePlaceholder: string;
  pickOneOrMore: string;
  selected: (count: number) => string;
  /** Beside the button that takes a typed value. */
  enterHint: string;
  notANumber: string;
  /** The date picker's text. */
  date: DateLabels;
  done: string;
  value: string;
  valuePlaceholder: string;
  numberPlaceholder: string;
  yearPlaceholder: string;
  true: string;
  false: string;
  is: string;
  isNot: string;
  isAnyOf: string;
  isNoneOf: string;
  contains: string;
  doesNotContain: string;
  startsWith: string;
  endsWith: string;
  isEmpty: string;
  isNotEmpty: string;
  after: string;
  onOrAfter: string;
  before: string;
  onOrBefore: string;
  yearIs: string;
}

/** The filter builder's text in the current language. */
export function filterLabels(): FilterLabels {
  return {
    filters: t({ message: "Filters", context: "Filter builder" }),
    filter: t({ message: "Filter", context: "Filter builder" }),
    addFilter: t({ message: "Add filter", context: "Filter builder" }),
    match: t({ message: "Match", context: "Filter builder" }),
    matchAll: t({ message: "Match all", context: "Filter builder" }),
    matchAny: t({ message: "Match any", context: "Filter builder" }),
    exclude: t({ message: "Exclude", context: "Filter builder" }),
    howFiltersCombine: t({ message: "How the filters combine", context: "Filter builder" }),
    all: t({ message: "All", context: "Filter group: every filter must match" }),
    any: t({ message: "Any", context: "Filter group: at least one filter must match" }),
    none: t({ message: "None", context: "Filter group: no filter may match" }),
    everyFilter: t({ message: "every filter", context: "Filter builder" }),
    atLeastOne: t({ message: "at least one", context: "Filter builder" }),
    noFilter: t({ message: "no filter", context: "Filter builder" }),
    howTheseCombine: t({ message: "How these filters combine", context: "Filter builder" }),
    group: name => t({ message: `${name} group`, context: "Filter builder" }),
    addFilterToGroup: t({ message: "Add filter to group", context: "Filter builder" }),
    addFilterToGroupHint: t({ message: "Add a filter to this group", context: "Filter builder" }),
    removeGroup: t({ message: "Remove group", context: "Filter builder" }),
    shared: t({ message: "Shared", context: "A filter every view applies" }),
    sharedHint: t({ message: "Applies to every view", context: "Filter builder" }),
    sharedName: name => t({ message: `Shared: ${name}`, context: "Filter builder" }),
    filterOptions: t({ message: "Filter options", context: "Filter builder" }),
    editAsExpression: t({ message: "Edit as expression", context: "Filter builder" }),
    convertToPill: t({ message: "Convert to filter", context: "Filter builder" }),
    wrapInOrGroup: t({ message: "Wrap in “any” group", context: "Filter builder" }),
    moveToShared: t({ message: "Move to shared", context: "Filter builder" }),
    moveToSharedHint: t({ message: "All views", context: "Filter builder" }),
    moveToView: t({ message: "Move to this view", context: "Filter builder" }),
    remove: t({ message: "Remove", context: "Filter builder" }),
    removeFilter: t({ message: "Remove filter", context: "Filter builder" }),
    lockedField: field => t({ message: `The filter on ${field} cannot be removed here`, context: "Filter builder" }),
    operator: t({ message: "Operator", context: "Filter builder" }),
    changeOperator: t({ message: "Change operator", context: "Filter builder" }),
    chooseValue: t({ message: "Choose value", context: "Filter builder" }),
    editValue: t({ message: "Edit value", context: "Filter builder" }),
    expressionName: text => (text ? t({ message: `Expression ${text}`, context: "Filter builder" }) : t({ message: "Empty expression", context: "Filter builder" })),
    expression: t({ message: "expression", context: "Filter builder" }),
    editExpression: t({ message: "Edit expression", context: "Filter builder" }),
    celExpression: t({ message: "CEL expression", context: "Filter builder" }),
    celHint: t({ message: "CEL · Shift+Enter for a new line", context: "Filter builder" }),
    apply: t({ message: "Apply", context: "Filter builder" }),
    customExpression: t({ message: "Custom expression", context: "Filter builder" }),
    filterGroup: t({ message: "Filter group", context: "Filter builder" }),
    filterGroupHint: t({ message: "Any / All", context: "Filter builder" }),
    back: t({ message: "Back", context: "Filter builder" }),
    filterByField: t({ message: "Filter by field", context: "Filter builder" }),
    filterByPlaceholder: t({ message: "Filter by…", context: "Filter builder" }),
    fields: t({ message: "Fields", context: "Filter builder" }),
    noMatchingFields: t({ message: "No matching fields", context: "Filter builder" }),
    scope: t({ message: "Scope", context: "Which views a filter applies to" }),
    thisView: t({ message: "This view", context: "Filter builder" }),
    contextValues: t({ message: "Values to compare with", context: "Filter builder" }),
    compareWith: expr => t({ message: `Compare with ${expr}`, context: "Filter builder" }),
    values: t({ message: "Values", context: "Filter builder" }),
    noValues: t({ message: "No values to choose from.", context: "Filter builder" }),
    addValue: t({ message: "Add value", context: "Filter builder" }),
    addValuePlaceholder: t({ message: "Add value…", context: "Filter builder" }),
    pickOneOrMore: t({ message: "Pick one or more", context: "Filter builder" }),
    selected: count => t({ message: plural(count, { one: "# selected", other: "# selected" }), context: "Filter builder" }),
    enterHint: t({ message: "or press Enter", context: "Filter builder" }),
    notANumber: t({ message: "Not a number", context: "Filter builder" }),
    date: dateLabels(),
    done: t({ message: "Done", context: "Filter builder" }),
    value: t({ message: "Value", context: "Filter builder" }),
    valuePlaceholder: t({ message: "Value", context: "Filter builder" }),
    numberPlaceholder: t({ message: "Number", context: "Filter builder" }),
    yearPlaceholder: t({ message: "Year, e.g. 2026", context: "Filter builder" }),
    true: t({ message: "True", context: "Filter builder" }),
    false: t({ message: "False", context: "Filter builder" }),
    is: t({ message: "is", context: "Filter operator" }),
    isNot: t({ message: "is not", context: "Filter operator" }),
    isAnyOf: t({ message: "is any of", context: "Filter operator" }),
    isNoneOf: t({ message: "is none of", context: "Filter operator" }),
    contains: t({ message: "contains", context: "Filter operator" }),
    doesNotContain: t({ message: "does not contain", context: "Filter operator" }),
    startsWith: t({ message: "starts with", context: "Filter operator" }),
    endsWith: t({ message: "ends with", context: "Filter operator" }),
    isEmpty: t({ message: "is empty", context: "Filter operator" }),
    isNotEmpty: t({ message: "is not empty", context: "Filter operator" }),
    after: t({ message: "after", context: "Filter operator" }),
    onOrAfter: t({ message: "on or after", context: "Filter operator" }),
    before: t({ message: "before", context: "Filter operator" }),
    onOrBefore: t({ message: "on or before", context: "Filter operator" }),
    yearIs: t({ message: "year is", context: "Filter operator" }),
  };
}
