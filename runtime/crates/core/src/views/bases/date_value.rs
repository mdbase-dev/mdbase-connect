//! Typed date bridge for evaluation/cache values; rendering is captured under
//! the request meter and does not reparse dates or reset a budget at the boundary.

use super::{DateValue, EvaluationFailure, WorkBudget};

/// Validated typed date plus its bounded canonical display, evaluated once.
#[derive(Clone, Debug)]
pub struct EvaluatedDate {
    value: DateValue,
    plain: String,
}

impl EvaluatedDate {
    /// Keep the typed value and compute its public representation under the same
    /// caller-owned request meter; no intermediate collapse to String.
    pub fn new(value: DateValue, budget: &mut WorkBudget) -> Result<Self, EvaluationFailure> {
        let plain = value.plain(budget)?;
        Ok(Self { value, plain })
    }
    /// Exact typed instant in milliseconds.
    pub fn millis(&self) -> i64 {
        self.value.millis()
    }
    /// Actual retained timezone identity. Named aliases remain exact; a stored
    /// zero fixed offset is UTC and other fixed offsets use ±HH:MM. Original
    /// equivalent UTC/fixed-offset input spelling is not retained or claimed.
    /// No request, display-string parsing or host timezone inference occurs.
    pub fn timezone_name(&self) -> std::borrow::Cow<'static, str> {
        self.value.timezone_name()
    }
    /// Original date-only intent, not inferred from the display string.
    pub fn is_date_only(&self) -> bool {
        self.value.is_date_only()
    }
    /// Original typed date for property/calendar operations.
    pub fn value(&self) -> DateValue {
        self.value
    }
    /// Precomputed bounded representation. Callers meter copies separately.
    pub fn display(&self) -> &str {
        &self.plain
    }
}

// RuntimeValue structural equality preserves representation/intent. Expression
// date comparisons are a separate semantic overload, not this cache equality.
impl PartialEq for EvaluatedDate {
    fn eq(&self, other: &Self) -> bool {
        self.millis() == other.millis()
            && self.is_date_only() == other.is_date_only()
            && self.plain == other.plain
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::Value;
    use crate::views::bases::{BasesTimezone, RuntimeValue};

    #[test]
    fn date_cache_values_preserve_typed_payload_and_date_only_intent() {
        let mut budget = WorkBudget::new();
        let zone = BasesTimezone::capture("UTC", &mut budget).unwrap();
        let date = DateValue::parse("2026-06-10", zone, &mut budget).unwrap();
        let value = RuntimeValue::Date(EvaluatedDate::new(date, &mut budget).unwrap());
        assert!(value.is_truthy());
        assert!(!value.is_empty());
        assert_eq!(value.type_name(), "Date");
        assert_eq!(value.to_plain(), Value::string("2026-06-10"));
        let cloned = value.clone();
        let RuntimeValue::Date(date) = cloned else {
            panic!("typed date collapsed in cache");
        };
        assert!(date.is_date_only());
        assert_eq!(date.value().property("year", &mut budget).unwrap(), 2026);
        assert_eq!(date.millis(), value_date_millis(&value));
    }

    #[test]
    fn authoritative_timezone_identity_preserves_named_aliases_without_changing_equality() {
        for (input, expected) in [
            ("UTC", "UTC"),
            ("+05:45", "+05:45"),
            ("-03:30", "-03:30"),
            ("America/New_York", "America/New_York"),
            ("US/Eastern", "US/Eastern"),
        ] {
            let mut work = WorkBudget::new();
            let zone = BasesTimezone::capture(input, &mut work).unwrap();
            let value = EvaluatedDate::new(
                DateValue::parse("2026-06-10", zone, &mut work).unwrap(),
                &mut work,
            )
            .unwrap();
            assert_eq!(value.timezone_name(), expected);
            assert_eq!(value.clone().timezone_name(), expected);
            assert_eq!(value.display(), "2026-06-10");
        }
        let construct = |name: &str| {
            let mut work = WorkBudget::new();
            let zone = BasesTimezone::capture(name, &mut work).unwrap();
            EvaluatedDate::new(
                DateValue::parse("2026-06-10", zone, &mut work).unwrap(),
                &mut work,
            )
            .unwrap()
        };
        let canonical = construct("America/New_York");
        let alias = construct("US/Eastern");
        assert_eq!(
            canonical, alias,
            "legacy expression/cache equality is unchanged"
        );
        assert_ne!(canonical.timezone_name(), alias.timezone_name());
    }
    fn value_date_millis(value: &RuntimeValue) -> i64 {
        match value {
            RuntimeValue::Date(date) => date.millis(),
            _ => panic!("typed date"),
        }
    }

    #[test]
    fn construction_and_render_copy_reservations_share_the_meter() {
        let mut budget = WorkBudget::new();
        let zone = BasesTimezone::capture("UTC", &mut budget).unwrap();
        let date = DateValue::parse("2026-06-10 12:34:56", zone, &mut budget).unwrap();
        let value = RuntimeValue::Date(EvaluatedDate::new(date, &mut budget).unwrap());
        let mut tiny = WorkBudget::constrained(2_000_000, 100);
        assert!(!tiny.value(&value, 1, true));
        assert!(matches!(
            tiny.failure(),
            Some(EvaluationFailure::BudgetExceeded(_))
        ));
        assert!(EvaluatedDate::new(date, &mut tiny).is_err());
    }
}
