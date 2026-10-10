//! TaskSlice1 file fields/predicates dispatch to the qualified captured helpers.
use super::*;
impl Evaluator<'_, '_> {
    fn missing_file(&mut self, detail: &'static str) -> RuntimeValue {
        self.budget
            .fail(EvaluationFailure::MetadataUnavailable(detail));
        RuntimeValue::Null
    }
    fn file_text(&mut self, value: &str) -> RuntimeValue {
        if self.budget.text(value.len(), 6) {
            RuntimeValue::String(value.into())
        } else {
            RuntimeValue::Null
        }
    }
    pub(super) fn file_property(&mut self, key: &str) -> RuntimeValue {
        let Some(binding) = self.bindings.file else {
            return self.missing_file("file_metadata_not_captured");
        };
        match key {
            "path" => self.file_text(binding.file.path()),
            "name" | "basename" => self.file_text(binding.file.basename()),
            "folder" => self.file_text(binding.file.folder()),
            "ext" => self.file_text(binding.file.extension()),
            "size" => match binding.file.size(self.budget) {
                Ok(value) => RuntimeValue::Number(value as f64),
                Err(e) => {
                    self.budget.fail(e);
                    RuntimeValue::Null
                }
            },
            "ctime" | "mtime" => {
                let Some(clock) = self.bindings.clock else {
                    return self.missing_file("file_clock_not_captured");
                };
                let date = if key == "ctime" {
                    binding.file.created(clock.timezone(), self.budget)
                } else {
                    binding.file.modified(clock.timezone(), self.budget)
                };
                self.date_value(date)
            }
            "tags" => {
                let Some(tags) = binding.tags else {
                    return self.missing_file("file_tags_not_captured");
                };
                if !self.budget.vector(tags.len()) {
                    return RuntimeValue::Null;
                }
                let mut values = Vec::with_capacity(tags.len());
                for tag in tags {
                    values.push(self.file_text(tag));
                    if !self.budget.live() {
                        return RuntimeValue::Null;
                    }
                }
                RuntimeValue::List(values)
            }
            _ => self.refuse("file_field"),
        }
    }
    pub(super) fn file_method(
        &mut self,
        method: &str,
        arguments: &[Expr],
        scope: &Scope,
    ) -> RuntimeValue {
        let Some(binding) = self.bindings.file else {
            return self.missing_file("file_metadata_not_captured");
        };
        let values = self.arguments(arguments, scope);
        if !self.budget.live() {
            return RuntimeValue::Null;
        }
        match method {
            "hasTag" => {
                if values.is_empty() {
                    return RuntimeValue::Bool(false);
                }
                let Some(tags) = binding.tags else {
                    return self.missing_file("file_tags_not_captured");
                };
                if !self.budget.vector(values.len()) {
                    return RuntimeValue::Null;
                }
                let mut needles = Vec::with_capacity(values.len());
                for value in &values {
                    let RuntimeValue::String(value) = value else {
                        return self.refuse("file_tag_argument");
                    };
                    if value.starts_with("##") {
                        return self.refuse("tag_prefix_unqualified");
                    }
                    if !self.budget.text(value.len(), 1) {
                        return RuntimeValue::Null;
                    }
                    needles.push(value.clone());
                }
                match super::super::CapturedFile::has_tag(tags, &needles, self.budget) {
                    Ok(value) => RuntimeValue::Bool(value),
                    Err(e) => {
                        self.budget.fail(e);
                        RuntimeValue::Null
                    }
                }
            }
            "hasProperty" | "inFolder" => {
                let [RuntimeValue::String(value)] = values.as_slice() else {
                    return self.refuse("file_predicate_argument");
                };
                if method == "hasProperty" {
                    RuntimeValue::Bool(self.bindings.note.contains_key(value))
                } else {
                    match binding.file.in_folder(value, self.budget) {
                        Ok(value) => RuntimeValue::Bool(value),
                        Err(e) => {
                            self.budget.fail(e);
                            RuntimeValue::Null
                        }
                    }
                }
            }
            _ => self.refuse("file_method"),
        }
    }
}
