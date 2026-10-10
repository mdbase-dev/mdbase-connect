//! Bounded program ownership and reachable-formula admission for the primitive
//! evaluator port. Deferred capabilities visibly refuse, even in lazy branches.

use std::collections::{BTreeMap, BTreeSet};

use super::syntax::qualify_syntax;
use super::{Error, ErrorKind, Expr, Expression, Member};

/// Maximum formula definitions per program, including unused definitions.
pub const MAX_FORMULAS: usize = 128;
/// Cumulative UTF-8 source/name bytes before parsing/copying definitions.
pub const MAX_PROGRAM_SOURCE_BYTES: usize = 65_536;
/// Cumulative AST nodes, including unused definitions.
pub const MAX_PROGRAM_NODES: usize = 4_096;
const MAX_ADMISSION_STEPS: u64 = 65_536;

/// Explicit component qualification profiles, not saved-view activation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Profile {
    /// Frozen primitive witness; date/file/link capabilities refuse.
    Primitive,
    /// Primitive operations plus captured date/clock operations.
    Calendar,
    /// Calendar operations plus qualified typed durations and date overloads.
    Duration,
    /// Duration plus bounded English ddd/MMM D formatting and JS-style round.
    /// Component profile only, not a complete first-slice saved-view executor.
    Slice1,
    /// Slice1 plus explicit captured first-slice file fields/predicates. Bare
    /// File/Link values, graph resolution and file.tasks still refuse.
    TaskSlice1,
}

struct CalendarAdmission {
    enabled: bool,
    duration_enabled: bool,
    slice1_enabled: bool,
    file_enabled: bool,
    requires_file: bool,
    requires_clock: bool,
    requires_ctime: bool,
    requires_mtime: bool,
    requires_tags: bool,
}

/// Owned, admitted component-profile expression and formula library.
/// This is not yet a full saved-view plan or a view-level capability descriptor.
#[derive(Debug)]
pub struct Program {
    pub(super) expression: Expression,
    pub(super) formulas: BTreeMap<String, Expression>,
    pub(super) profile: Profile,
    pub(super) requires_clock: bool,
    pub(super) requires_file: bool,
}

impl Program {
    /// Compile one root and its formula library. Syntax-validate every definition;
    /// capability-check only reachable definitions. Missing/cyclic formula refs
    /// refuse before any row is evaluated. Source, node and admission-work ceilings
    /// are cumulative, not reset once per formula. Memoize DAG qualification by
    /// definition/depth so repeated references cannot expand exponentially.
    pub fn compile(source: &str, formulas: &BTreeMap<String, String>) -> Result<Self, Error> {
        Self::compile_with_profile(source, formulas, Profile::Primitive)
    }

    /// Widen admission explicitly without replacing or duplicating the evaluator.
    /// Calendar calls require one captured clock/zone before evaluation, including
    /// calls in lazy branches of reachable formulas; unused libraries do not.
    pub fn compile_with_profile(
        source: &str,
        formulas: &BTreeMap<String, String>,
        profile: Profile,
    ) -> Result<Self, Error> {
        Self::compile_internal(source, formulas, profile, None).map(|(program, _)| program)
    }
    pub(super) fn compile_view(
        source: &str,
        formulas: &BTreeMap<String, String>,
        semantic: usize,
        times: super::FileTimeAvailability,
    ) -> Result<(Self, Vec<Option<&'static str>>), Error> {
        Self::compile_internal(
            source,
            formulas,
            Profile::TaskSlice1,
            Some((semantic, times)),
        )
    }
    fn compile_internal(
        source: &str,
        formulas: &BTreeMap<String, String>,
        profile: Profile,
        view: Option<(usize, super::FileTimeAvailability)>,
    ) -> Result<(Self, Vec<Option<&'static str>>), Error> {
        if formulas.len() > MAX_FORMULAS {
            return Err(limit("formula_count"));
        }
        let mut bytes = source.len();
        for (name, definition) in formulas {
            bytes = bytes
                .checked_add(name.len())
                .and_then(|n| n.checked_add(definition.len()))
                .ok_or_else(|| limit("program_source_bytes"))?;
        }
        if bytes > MAX_PROGRAM_SOURCE_BYTES {
            return Err(limit("program_source_bytes"));
        }
        qualify_syntax(source)?;
        let expression = Expression::parse(source)?;
        let mut nodes = expression.node_count();
        let mut parsed = BTreeMap::new();
        for (name, definition) in formulas {
            qualify_syntax(definition)?;
            let value = Expression::parse(definition)?;
            nodes = nodes
                .checked_add(value.node_count())
                .ok_or_else(|| limit("program_nodes"))?;
            if nodes > MAX_PROGRAM_NODES {
                return Err(limit("program_nodes"));
            }
            parsed.insert(name.clone(), value);
        }
        let mut calendar = CalendarAdmission {
            enabled: profile != Profile::Primitive,
            duration_enabled: matches!(
                profile,
                Profile::Duration | Profile::Slice1 | Profile::TaskSlice1
            ),
            slice1_enabled: matches!(profile, Profile::Slice1 | Profile::TaskSlice1),
            file_enabled: profile == Profile::TaskSlice1,
            requires_file: false,
            requires_clock: false,
            requires_ctime: false,
            requires_mtime: false,
            requires_tags: false,
        };
        let mut unavailable = Vec::new();
        if let Some((semantic, times)) = view {
            let Expr::Array(roots) = expression.ast() else {
                return Err(unsupported("base_view_program_shape"));
            };
            let mut steps = MAX_ADMISSION_STEPS;
            for (index, root) in roots.iter().enumerate() {
                let mut capture = CalendarAdmission {
                    enabled: true,
                    duration_enabled: true,
                    slice1_enabled: true,
                    file_enabled: true,
                    requires_file: false,
                    requires_clock: false,
                    requires_ctime: false,
                    requires_mtime: false,
                    requires_tags: false,
                };
                let result = admit(
                    root,
                    &parsed,
                    &mut BTreeSet::new(),
                    &mut BTreeSet::new(),
                    2,
                    &mut steps,
                    &mut capture,
                );
                let missing = (capture.requires_ctime && !times.created)
                    || (capture.requires_mtime && !times.modified);
                if index <= semantic {
                    result?;
                    if missing {
                        return Err(unsupported("file_time_not_captured"));
                    }
                } else {
                    match result {
                        Err(Error {
                            kind: ErrorKind::UnsupportedConstruct(detail),
                            ..
                        }) => {
                            unavailable.push(Some(detail));
                            continue;
                        }
                        Err(e) => return Err(e),
                        Ok(()) if missing || (capture.requires_tags && !times.tags) => {
                            unavailable.push(Some(if missing {
                                "file_time_not_captured"
                            } else {
                                "file_tags_not_captured"
                            }));
                            continue;
                        }
                        Ok(()) => unavailable.push(None),
                    }
                }
                calendar.requires_file |= capture.requires_file;
                calendar.requires_clock |= capture.requires_clock;
            }
        } else {
            let mut active = BTreeSet::new();
            let mut seen = BTreeSet::new();
            let mut steps = MAX_ADMISSION_STEPS;
            admit(
                expression.ast(),
                &parsed,
                &mut active,
                &mut seen,
                1,
                &mut steps,
                &mut calendar,
            )?;
        }
        Ok((
            Self {
                expression,
                formulas: parsed,
                profile,
                requires_clock: calendar.requires_clock,
                requires_file: calendar.requires_file,
            },
            unavailable,
        ))
    }
}

fn limit(detail: &'static str) -> Error {
    Error::new(ErrorKind::BudgetExceeded(detail), 0)
}
fn unsupported(detail: &'static str) -> Error {
    Error::new(ErrorKind::UnsupportedConstruct(detail), 0)
}

pub(super) fn formula_name<'a>(
    operand: &Expr,
    member: &'a Member,
) -> Result<Option<&'a str>, Error> {
    if !matches!(operand, Expr::Identifier(name) if name == "formula") {
        return Ok(None);
    }
    match member {
        Member::Named(name) => Ok(Some(name)),
        Member::Computed(key) => match key.as_ref() {
            Expr::Literal(crate::value::Value::Text(name)) => Ok(Some(name)),
            _ => Err(unsupported("dynamic_formula_reference")),
        },
    }
}

fn admit<'a>(
    expr: &Expr,
    formulas: &'a BTreeMap<String, Expression>,
    active: &mut BTreeSet<&'a str>,
    seen: &mut BTreeSet<(&'a str, usize)>,
    depth: usize,
    steps: &mut u64,
    calendar: &mut CalendarAdmission,
) -> Result<(), Error> {
    if depth > super::MAX_AST_DEPTH {
        return Err(limit("program_depth"));
    }
    *steps = steps
        .checked_sub(1)
        .ok_or_else(|| limit("admission_work"))?;
    match expr {
        Expr::Literal(_) => {}
        Expr::Regex(_, _) => return Err(unsupported("regex_literal")),
        Expr::Identifier(name) if matches!(name.as_str(), "file" | "this") => {
            return Err(unsupported("file_or_invocation_context"));
        }
        Expr::Identifier(_) => {}
        Expr::Array(values) => {
            for value in values {
                admit(value, formulas, active, seen, depth + 1, steps, calendar)?;
            }
        }
        Expr::Unary(operator, value) => {
            if operator == "+" {
                return Err(unsupported("unary_plus"));
            }
            admit(value, formulas, active, seen, depth + 1, steps, calendar)?;
        }
        Expr::Binary(_, left, right) => {
            admit(left, formulas, active, seen, depth + 1, steps, calendar)?;
            admit(right, formulas, active, seen, depth + 1, steps, calendar)?;
        }
        Expr::Member(operand, member) => {
            if calendar.file_enabled
                && let Some(name) = super::file_bindings::field_name(operand, member)
            {
                if !matches!(
                    name,
                    "path"
                        | "name"
                        | "basename"
                        | "folder"
                        | "ext"
                        | "size"
                        | "ctime"
                        | "mtime"
                        | "tags"
                ) {
                    return Err(unsupported("file_field"));
                }
                calendar.requires_file = true;
                calendar.requires_tags |= name == "tags";
                if matches!(name, "ctime" | "mtime") {
                    calendar.requires_clock = true;
                    calendar.requires_ctime |= name == "ctime";
                    calendar.requires_mtime |= name == "mtime";
                }
            } else if let Some(name) = formula_name(operand, member)? {
                let (canonical, definition) = formulas
                    .get_key_value(name)
                    .ok_or_else(|| Error::new(ErrorKind::InvalidSource("unresolved_formula"), 0))?;
                let name = canonical.as_str();
                if active.contains(name) {
                    return Err(Error::new(ErrorKind::FormulaCycle, 0));
                }
                if seen.insert((name, depth)) {
                    active.insert(name);
                    admit(
                        definition.ast(),
                        formulas,
                        active,
                        seen,
                        depth + 1,
                        steps,
                        calendar,
                    )?;
                    active.remove(name);
                }
            } else {
                admit(operand, formulas, active, seen, depth + 1, steps, calendar)?;
                if let Member::Computed(key) = member {
                    admit(key, formulas, active, seen, depth + 1, steps, calendar)?;
                }
            }
        }
        Expr::Call(callee, arguments) => {
            match callee.as_ref() {
                Expr::Identifier(name)
                    if matches!(name.as_str(), "if" | "list" | "min" | "max" | "number") => {}
                Expr::Identifier(name)
                    if calendar.enabled && matches!(name.as_str(), "date" | "now" | "today") =>
                {
                    calendar.requires_clock = true;
                }
                Expr::Identifier(name) if calendar.duration_enabled && name == "duration" => {}
                Expr::Identifier(_) => return Err(unsupported("global_function")),
                Expr::Member(operand, Member::Named(name))
                    if calendar.file_enabled
                        && matches!(operand.as_ref(),Expr::Identifier(id) if id=="file")
                        && matches!(name.as_str(), "hasTag" | "hasProperty" | "inFolder") =>
                {
                    calendar.requires_file = true;
                    calendar.requires_tags |= name == "hasTag" && !arguments.is_empty();
                }
                Expr::Member(operand, Member::Named(name))
                    if matches!(
                        name.as_str(),
                        "isTruthy"
                            | "isEmpty"
                            | "isType"
                            | "toString"
                            | "contains"
                            | "containsAll"
                            | "containsAny"
                            | "startsWith"
                            | "endsWith"
                            | "lower"
                            | "trim"
                            | "replace"
                            | "repeat"
                            | "reverse"
                            | "slice"
                            | "split"
                            | "abs"
                            | "ceil"
                            | "floor"
                            | "keys"
                            | "values"
                            | "map"
                            | "filter"
                            | "reduce"
                            | "flat"
                            | "join"
                            | "unique"
                            | "sum"
                            | "mean"
                    ) =>
                {
                    admit(operand, formulas, active, seen, depth + 1, steps, calendar)?
                }
                Expr::Member(operand, Member::Named(name))
                    if calendar.enabled && matches!(name.as_str(), "date" | "format" | "time") =>
                {
                    admit(operand, formulas, active, seen, depth + 1, steps, calendar)?;
                }
                Expr::Member(operand, Member::Named(name))
                    if calendar.slice1_enabled && name == "round" =>
                {
                    admit(operand, formulas, active, seen, depth + 1, steps, calendar)?;
                }
                Expr::Member(_, _) => return Err(unsupported("method")),
                _ => return Err(unsupported("call_target")),
            }
            for argument in arguments {
                admit(argument, formulas, active, seen, depth + 1, steps, calendar)?;
            }
        }
    }
    Ok(())
}
