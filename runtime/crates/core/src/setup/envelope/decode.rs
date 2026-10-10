//! The external CollectionSetup envelope stays requirements/provisions-shaped.
//! Typed Core storage is normalized internally; the nested provision loader is
//! the trusted installer bridge and still uses strict type-pack loading.
use super::{
    CollectionSetup, CollectionSetupTypePack, MAX_PACK_BYTES, MAX_TYPE_PACKS, invalid, limit,
};
use crate::ids::Hash;
use crate::setup::configuration::ConfigurationDeclaration;
use crate::validate::Issue;
use crate::value::{Map, Value};
fn bound(root: &Value, max_bytes: usize) -> Result<(), Box<Issue>> {
    let mut stack = vec![(root, 0u32)];
    let mut nodes = 0usize;
    let mut bytes = 0usize;
    while let Some((value, depth)) = stack.pop() {
        nodes = nodes.checked_add(1).ok_or_else(limit)?;
        if nodes > 65_536 || depth > 32 {
            return Err(limit());
        }
        match value {
            Value::Text(s) => bytes = bytes.checked_add(s.len()).ok_or_else(limit)?,
            Value::Map(m) => {
                if m.len() > 65_536 || stack.len().saturating_add(m.len()) > 65_536 {
                    return Err(limit());
                }
                for (k, v) in m.iter() {
                    bytes = bytes.checked_add(k.len()).ok_or_else(limit)?;
                    stack.push((v, depth + 1));
                }
            }
            Value::List(v) => {
                if v.len() > 65_536 || stack.len().saturating_add(v.len()) > 65_536 {
                    return Err(limit());
                }
                stack.extend(v.iter().map(|v| (v, depth + 1)));
            }
            Value::Float(f) if !f.is_finite() => return Err(invalid()),
            _ => {}
        }
        if bytes > max_bytes {
            return Err(limit());
        }
    }
    Ok(())
}
impl CollectionSetup {
    /// Decode the original envelope shape strictly. The installer loads each
    /// `{provision,options}` entry through its typed, strict type-pack bridge.
    /// This callback is never an app-side configuration merger or authority.
    pub fn from_value(
        value: &Value,
        load: &dyn Fn(&Value) -> Result<CollectionSetupTypePack, Box<Issue>>,
    ) -> Result<Self, Box<Issue>> {
        bound(value, MAX_PACK_BYTES + 65_536)?;
        let root = value.as_map().ok_or_else(invalid)?;
        if root.keys().any(|k| {
            !matches!(
                k,
                "application_id" | "declaration_digest" | "requirements" | "provisions"
            )
        }) {
            return Err(invalid());
        }
        let application = root
            .get("application_id")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        if application.len() > 150 {
            return Err(limit());
        }
        let digest = root
            .get("declaration_digest")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        if digest.len() != 71
            || !digest.starts_with("sha256:")
            || !digest[7..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid());
        }
        let declaration_digest = Hash::parse(digest).ok_or_else(invalid)?;
        let empty = Map::new();
        let requirements = match root.get("requirements") {
            Some(v) => v.as_map().ok_or_else(invalid)?,
            None => &empty,
        };
        let provisions = match root.get("provisions") {
            Some(v) => v.as_map().ok_or_else(invalid)?,
            None => &empty,
        };
        if requirements.keys().any(|k| k != "configuration")
            || provisions
                .keys()
                .any(|k| !matches!(k, "configuration" | "type_packs"))
        {
            return Err(invalid());
        }
        for m in [requirements, provisions] {
            if let Some(v) = m.get("configuration") {
                if v.as_list().is_none_or(|a| a.len() > 128) {
                    return Err(invalid());
                }
                bound(v, 65_536)?;
            }
        }
        let mut declaration = Map::new();
        declaration.insert(
            "requirements",
            requirements
                .get("configuration")
                .cloned()
                .unwrap_or_else(|| Value::List(Vec::new())),
        );
        declaration.insert(
            "provisions",
            provisions
                .get("configuration")
                .cloned()
                .unwrap_or_else(|| Value::List(Vec::new())),
        );
        let configuration = ConfigurationDeclaration::from_value(&Value::Map(declaration))?;
        let empty_packs = Vec::new();
        let entries = match provisions.get("type_packs") {
            Some(v) => v.as_list().ok_or_else(invalid)?,
            None => &empty_packs,
        };
        if entries.len() > MAX_TYPE_PACKS {
            return Err(limit());
        }
        let mut setup = Self {
            application_id: application.into(),
            declaration_digest,
            configuration,
            type_packs: Vec::new(),
        };
        setup.validate()?;
        for entry in entries {
            let m = entry.as_map().ok_or_else(invalid)?;
            if !m.contains_key("provision")
                || m.keys().any(|k| !matches!(k, "provision" | "options"))
            {
                return Err(invalid());
            }
            setup.type_packs.push(load(entry)?);
        }
        setup.validate()?;
        Ok(setup)
    }
}
