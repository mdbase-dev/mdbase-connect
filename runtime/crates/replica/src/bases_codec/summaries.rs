//! Optional field 9: bounded named tagged values, independent of row/window size.
use super::*;
use std::collections::BTreeSet;

pub(super) fn admit(values: &[(String, RuntimeValue)]) -> ApiResult<()> {
    if values.len() > 64 {
        return Err(too_large());
    }
    let mut names = BTreeSet::new();
    let mut bounds = Bounds { nodes: 0, bytes: 0 };
    for (name, value) in values {
        if name.is_empty()
            || name.len() > 1024
            || name.chars().any(char::is_control)
            || !names.insert(name.as_str())
        {
            return Err(too_large());
        }
        bounds.charge(name.len() + 64)?;
        bounds.value(value, 1)?;
    }
    Ok(())
}
struct Bounds {
    nodes: usize,
    bytes: usize,
}
impl Bounds {
    fn charge(&mut self, bytes: usize) -> ApiResult<()> {
        self.nodes += 1;
        self.bytes += bytes;
        if self.nodes > 4096 || self.bytes > 1 << 20 {
            return Err(too_large());
        }
        Ok(())
    }
    fn value(&mut self, value: &RuntimeValue, depth: usize) -> ApiResult<()> {
        if depth > 32 {
            return Err(too_large());
        }
        self.charge(128)?;
        match value {
            RuntimeValue::String(text) | RuntimeValue::Error(text) => self.charge(text.len())?,
            RuntimeValue::List(items) => {
                for value in items {
                    self.value(value, depth + 1)?;
                }
            }
            RuntimeValue::Object(items) => {
                for (key, value) in items {
                    self.charge(key.len() + 64)?;
                    self.value(value, depth + 1)?;
                }
            }
            RuntimeValue::Date(value) => {
                self.charge(value.display().len() + value.timezone_name().len())?
            }
            RuntimeValue::Duration(value) => self.charge(value.display().len())?,
            _ => {}
        }
        Ok(())
    }
}
