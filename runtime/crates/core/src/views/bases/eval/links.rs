//! Link property capture and the boundary of what a link value may do.
//! In the Obsidian 1.12.7 bundle pinned in `docs/bases-list-grouping.md`,
//! `ListValue.includes` compares the needle first. Plain text matches a link's
//! written target (everything before its last alias pipe), not its resolved file.
//! Unqualified operations refuse rather than guessing at link semantics.
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

    pub(super) fn link_list_contains_text(
        &mut self,
        values: &[RuntimeValue],
        arg: &Expr,
        scope: &Scope,
    ) -> RuntimeValue {
        let RuntimeValue::String(needle) = self.evaluate(arg, scope) else {
            return self.refuse("link_property");
        };
        if needle.starts_with("[[") && needle.ends_with("]]") {
            return self.refuse("link_property");
        }
        let mut found = false;
        for value in values {
            if !self.budget.charge(1, 0) {
                return RuntimeValue::Null;
            }
            found |= match value {
                RuntimeValue::String(text) => text == &needle,
                RuntimeValue::Link(link) => {
                    match link.display().and_then(|alias| alias.rsplit_once('|')) {
                        Some((middle, _)) => needle.split_once('|') == Some((link.path(), middle)),
                        None => link.path() == needle,
                    }
                }
                _ => return self.refuse("link_property"),
            };
        }
        RuntimeValue::Bool(found)
    }

    pub(super) fn contains_link(&mut self, value: &RuntimeValue) -> Option<bool> {
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
