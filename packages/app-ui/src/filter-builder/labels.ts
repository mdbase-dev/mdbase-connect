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
    filters: t`Filters`,
    filter: t`Filter`,
    addFilter: t`Add filter`,
    match: t`Match`,
    matchAll: t`Match all`,
    matchAny: t`Match any`,
    exclude: t`Exclude`,
    howFiltersCombine: t`How the filters combine`,
    all: t({ message: "All", context: "Filter group: every filter must match" }),
    any: t({ message: "Any", context: "Filter group: at least one filter must match" }),
    none: t({ message: "None", context: "Filter group: no filter may match" }),
    everyFilter: t`every filter`,
    atLeastOne: t`at least one`,
    noFilter: t`no filter`,
    howTheseCombine: t`How these filters combine`,
    group: name => t`${name} group`,
    addFilterToGroup: t`Add filter to group`,
    addFilterToGroupHint: t`Add a filter to this group`,
    removeGroup: t`Remove group`,
    shared: t({ message: "Shared", context: "A filter every view applies" }),
    sharedHint: t`Applies to every view`,
    sharedName: name => t`Shared: ${name}`,
    filterOptions: t`Filter options`,
    editAsExpression: t`Edit as expression`,
    convertToPill: t`Convert to filter`,
    wrapInOrGroup: t`Wrap in “any” group`,
    moveToShared: t`Move to shared`,
    moveToSharedHint: t`All views`,
    moveToView: t`Move to this view`,
    remove: t`Remove`,
    removeFilter: t`Remove filter`,
    lockedField: field => t`The filter on ${field} cannot be removed here`,
    operator: t`Operator`,
    changeOperator: t`Change operator`,
    chooseValue: t`Choose value`,
    editValue: t`Edit value`,
    expressionName: text => (text ? t`Expression ${text}` : t`Empty expression`),
    expression: t`expression`,
    editExpression: t`Edit expression`,
    celExpression: t`CEL expression`,
    celHint: t`CEL · Shift+Enter for a new line`,
    apply: t`Apply`,
    customExpression: t`Custom expression`,
    filterGroup: t`Filter group`,
    filterGroupHint: t`Any / All`,
    back: t`Back`,
    filterByField: t`Filter by field`,
    filterByPlaceholder: t`Filter by…`,
    fields: t`Fields`,
    noMatchingFields: t`No matching fields`,
    scope: t({ message: "Scope", context: "Which views a filter applies to" }),
    thisView: t`This view`,
    contextValues: t`Values to compare with`,
    compareWith: expr => t`Compare with ${expr}`,
    values: t`Values`,
    noValues: t`No values to choose from.`,
    addValue: t`Add value`,
    addValuePlaceholder: t`Add value…`,
    pickOneOrMore: t`Pick one or more`,
    selected: count => plural(count, { one: "# selected", other: "# selected" }),
    enterHint: t`or press Enter`,
    notANumber: t`Not a number`,
    date: dateLabels(),
    done: t`Done`,
    value: t`Value`,
    valuePlaceholder: t`Value`,
    numberPlaceholder: t`Number`,
    yearPlaceholder: t`Year, e.g. 2026`,
    true: t`True`,
    false: t`False`,
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
