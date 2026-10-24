//! Qualified duration/date overloads adapted from the original Rust port.
use super::*;

impl Evaluator<'_, '_> {
    pub(super) fn duration_value(
        &mut self,
        result: Result<DurationValue, EvaluationFailure>,
    ) -> RuntimeValue {
        match result.and_then(|v| EvaluatedDuration::new(v, self.budget)) {
            Ok(value) => RuntimeValue::Duration(value),
            Err(failure) => {
                self.budget.fail(failure);
                RuntimeValue::Null
            }
        }
    }
    pub(super) fn duration_number(&mut self, value: &EvaluatedDuration) -> Result<f64, String> {
        let parts = value.value().components();
        if parts[0] != 0.0 || parts[1] != 0.0 {
            self.refuse("calendar_duration_number");
            return Err(String::new());
        }
        value.value().fixed_millis(self.budget).map_err(|failure| {
            self.budget.fail(failure);
            String::new()
        })
    }
    pub(super) fn duration_binary(
        &mut self,
        operator: &str,
        left: &RuntimeValue,
        right: &RuntimeValue,
    ) -> Option<RuntimeValue> {
        match (operator, left, right) {
            ("-", RuntimeValue::Date(a), RuntimeValue::Date(b)) => {
                let Some(delta) = a.millis().checked_sub(b.millis()) else {
                    return Some(self.refuse("date_range"));
                };
                // Supported date years are 1..9999, so the difference is <2^53.
                #[allow(clippy::cast_precision_loss)]
                let millis = delta as f64;
                let result = DurationValue::from_components(
                    [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, millis],
                    self.budget,
                );
                Some(self.duration_value(result))
            }
            ("+" | "-", RuntimeValue::Date(date), _) => {
                let duration = match right {
                    RuntimeValue::Duration(value) => Ok(value.value()),
                    RuntimeValue::String(text) => DurationValue::parse(text, self.budget),
                    _ => return Some(self.refuse("date_arithmetic")),
                };
                let result = duration.and_then(|value| {
                    self.add_duration(
                        date.value(),
                        value,
                        if operator == "+" { 1.0 } else { -1.0 },
                    )
                });
                Some(self.date_value(result))
            }
            ("+", RuntimeValue::Duration(a), RuntimeValue::Duration(b)) => {
                let result = a.value().add(b.value(), self.budget);
                Some(self.duration_value(result))
            }
            ("*", RuntimeValue::Duration(value), RuntimeValue::Number(factor)) => {
                let result = value.value().scale(*factor, self.budget);
                Some(self.duration_value(result))
            }
            ("*", RuntimeValue::Number(_), RuntimeValue::Duration(_)) => {
                const MESSAGE: &str = "Invalid operator between Number and Duration";
                Some(if self.budget.text(MESSAGE.len(), 1) {
                    RuntimeValue::Error(MESSAGE.to_owned())
                } else {
                    RuntimeValue::Null
                })
            }
            _ => None,
        }
    }
    fn add_duration(
        &mut self,
        date: DateValue,
        duration: DurationValue,
        direction: f64,
    ) -> Result<DateValue, EvaluationFailure> {
        let parts = duration.components();
        if parts[0].fract() != 0.0 || parts[1].fract() != 0.0 {
            return self.duration_refusal("fractional_calendar_duration");
        }
        let months = (parts[0] * 12.0 + parts[1]) * direction;
        let Some(months) = integer(months) else {
            return self.duration_refusal("date_range");
        };
        let millis = duration.fixed_millis(self.budget)? * direction;
        // The legacy round/saturating cast is not an oracle-qualified fallback.
        if millis.fract() != 0.0 {
            return self.duration_refusal("submillisecond_date");
        }
        if !millis.is_finite() || millis.abs() > 9_007_199_254_740_991.0 {
            return self.duration_refusal("date_range");
        }
        let Some(millis) = integer(millis) else {
            return self.duration_refusal("date_range");
        };
        date.add_months(months, self.budget)?
            .add_millis(millis, self.budget)
    }
    fn duration_refusal<T>(&mut self, detail: &'static str) -> Result<T, EvaluationFailure> {
        self.refuse(detail);
        Err(self.budget.failure().expect("sticky refusal"))
    }
}
