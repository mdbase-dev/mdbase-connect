//! Link property capture and the boundary of what a link value may do.
//! Grouping, sorting, emptiness and rendering are observed on Obsidian. Other
//! operations have no qualified link semantics, so they refuse, not guess.
use super::super::links::property_link;
use super::*;

impl Evaluator<'_, '_> {
    pub(super) fn link_property(&mut self, text: &str) -> RuntimeValue {
        let (Some(links), Some(file), Some(link)) =
            (self.bindings.links, self.bindings.file, property_link(text))
        else {
            return self.refuse("link_property");
        };
        match links.capture(text, &link, file.file.path(), self.budget) {
            Ok(link) => RuntimeValue::Link(link),
            Err(failure) => {
                self.budget.fail(failure);
                RuntimeValue::Null
            }
        }
    }

    pub(super) fn link_string(&mut self, value: &RuntimeValue) -> RuntimeValue {
        if self.budget.value(value, 1, true) {
            RuntimeValue::String(value.plain_string())
        } else {
            RuntimeValue::Null
        }
    }

    /// Refuse a value holding a link at any depth. True when this row is done.
    pub(super) fn refuse_link(&mut self, value: &RuntimeValue) -> bool {
        match self.contains_link(value) {
            Some(false) => false,
            Some(true) => {
                self.refuse("link_property");
                true
            }
            None => true,
        }
    }

    fn contains_link(&mut self, value: &RuntimeValue) -> Option<bool> {
        if !self.budget.charge(1, 0) {
            return None;
        }
        let children: Vec<&RuntimeValue> = match value {
            RuntimeValue::Link(_) => return Some(true),
            RuntimeValue::List(values) => values.iter().collect(),
            RuntimeValue::Object(values) => values.values().collect(),
            _ => return Some(false),
        };
        for child in children {
            if self.contains_link(child)? {
                return Some(true);
            }
        }
        Some(false)
    }
}
