//! Only hosted/escrow composition points may request migration key custody.
//! Inspect declarations, not just currently enabled features: CI must reject an
//! unsafe optional/target-specific feature even when the default build omits it.
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::Path;

const FEATURE: &str = "hosted-service";

pub(super) fn violations(meta: &Value) -> Vec<String> {
    let members: BTreeSet<&str> = meta["workspace_members"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let mut errors = Vec::new();
    for pkg in meta["packages"].as_array().into_iter().flatten() {
        let name = pkg["name"].as_str().unwrap_or("");
        let features = &pkg["features"];
        if name == "mdbn-migrate" {
            for root in features.as_object().into_iter().flat_map(|f| f.keys()) {
                if root != FEATURE && local_reaches(features, root, FEATURE, &mut BTreeSet::new()) {
                    errors.push(format!("mdbn-migrate: feature {root} must not alias or enable hosted-service; custody requires the explicit feature"));
                }
            }
        }
        let allowed_path = match name {
            "mdbn-hosted" => Some("crates/hosted/Cargo.toml"),
            "mdbn-escrow" => Some("crates/escrow/Cargo.toml"),
            _ => None,
        };
        let authorized = members.contains(pkg["id"].as_str().unwrap_or(""))
            && allowed_path.is_some_and(|suffix| {
                Path::new(pkg["manifest_path"].as_str().unwrap_or("")).ends_with(suffix)
            });
        for dep in pkg["dependencies"].as_array().into_iter().flatten() {
            let target = dep["name"].as_str().unwrap_or("");
            if !["mdbn-migrate", "mdbn-hosted", "mdbn-escrow"].contains(&target) {
                continue;
            }
            let alias = dep["rename"].as_str().unwrap_or(target);
            let direct = dep["features"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|f| f.as_str() == Some(FEATURE));
            let forwarded = features
                .as_object()
                .into_iter()
                .flat_map(|f| f.values())
                .flat_map(|v| v.as_array().into_iter().flatten())
                .filter_map(Value::as_str)
                .any(|s| forwards(s, alias));
            if !direct && !forwarded {
                continue;
            }
            if !authorized || !dep["kind"].is_null() {
                errors.push(format!("{name}: only normal dependencies of crates/hosted or crates/escrow may enable {target}/{FEATURE} (including forwarded features)"));
                continue;
            }
            // The composition edge itself must remain behind the custody gate.
            if dep["optional"].as_bool() != Some(true) {
                errors.push(format!("{name}: {target}/{FEATURE} dependency must be optional and gated by the service's {FEATURE} feature"));
            }
            for root in features.as_object().into_iter().flat_map(|f| f.keys()) {
                if root == FEATURE {
                    continue;
                }
                if enables(features, root, alias, direct, &mut BTreeSet::new()) {
                    errors.push(format!("{name}: feature {root} can enable {target}/{FEATURE} outside the explicit {FEATURE} gate"));
                }
            }
        }
    }
    errors
}

fn forwards(value: &str, alias: &str) -> bool {
    value
        .split_once('/')
        .is_some_and(|(dep, feature)| dep.trim_end_matches('?') == alias && feature == FEATURE)
}

fn local_reaches(features: &Value, root: &str, target: &str, seen: &mut BTreeSet<String>) -> bool {
    if root == target {
        return true;
    }
    if !seen.insert(root.into()) {
        return false;
    }
    features[root]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|next| local_reaches(features, next, target, seen))
}

fn enables(
    features: &Value,
    root: &str,
    alias: &str,
    direct: bool,
    seen: &mut BTreeSet<String>,
) -> bool {
    if root == FEATURE {
        return true;
    }
    if !seen.insert(root.into()) {
        return false;
    }
    features[root]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|next| {
            forwards(next, alias)
                || (direct
                    && (next == format!("dep:{alias}")
                        || next == alias
                        || next.split_once('/').is_some_and(|(dep, _)| dep == alias)))
                || enables(features, next, alias, direct, seen)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn package(name: &str, optional: bool, requested: Value, features: Value) -> Value {
        let dir = match name {
            "mdbn-hosted" => "hosted",
            "mdbn-escrow" => "escrow",
            _ => "daemon",
        };
        json!({"id":name, "name":name, "manifest_path":format!("/repo/crates/{dir}/Cargo.toml"),
            "features":features, "dependencies":[{"name":"mdbn-migrate","rename":"migration",
                "kind":null,"optional":optional,"features":requested}]})
    }
    fn check(pkg: Value) -> Vec<String> {
        violations(&json!({"workspace_members":[pkg["id"]], "packages":[pkg]}))
    }
    #[test]
    fn only_service_composition_points_can_enable_reseal() {
        for name in ["mdbn-daemon", "mdbn-bench", "mdbn-wasm"] {
            assert!(!check(package(name, true, json!([FEATURE]), json!({}))).is_empty());
            assert!(
                !check(package(
                    name,
                    true,
                    json!([]),
                    json!({"opt-in":["migration?/hosted-service"]})
                ))
                .is_empty()
            );
        }
        assert!(
            check(package("mdbn-daemon", false, json!([]), json!({}))).is_empty(),
            "migration without reseal remains allowed"
        );
    }
    #[test]
    fn indirect_service_dependency_cannot_enable_custody_from_a_cli() {
        for target in ["mdbn-hosted", "mdbn-escrow"] {
            let mut p = package(
                "mdbn-daemon",
                true,
                json!([]),
                json!({"import":["migration/hosted-service"]}),
            );
            p["dependencies"][0]["name"] = json!(target);
            assert!(!check(p).is_empty());
        }
    }
    #[test]
    fn explicit_hosted_and_escrow_gates_are_allowed() {
        for name in ["mdbn-hosted", "mdbn-escrow"] {
            assert!(
                check(package(
                    name,
                    true,
                    json!([FEATURE]),
                    json!({"hosted-service":["dep:migration"]})
                ))
                .is_empty()
            );
            assert!(
                check(package(
                    name,
                    true,
                    json!([]),
                    json!({"hosted-service":["migration/hosted-service"]})
                ))
                .is_empty()
            );
        }
    }
    #[test]
    fn unconditional_and_indirect_default_enabling_is_rejected() {
        assert!(!check(package("mdbn-hosted", false, json!([FEATURE]), json!({}))).is_empty());
        for features in [
            json!({"default":["bridge"], "bridge":["hosted-service"], "hosted-service":["migration/hosted-service"]}),
            json!({"diagnostic":["migration?/hosted-service"]}),
            json!({"hosted-service":["dep:migration"], "migration":["dep:migration"]}),
        ] {
            assert!(!check(package("mdbn-hosted", true, json!([FEATURE]), features)).is_empty());
        }
    }
    #[test]
    fn dependency_kind_platform_and_workspace_inheritance_cannot_bypass_gate() {
        // cargo metadata expands workspace.dependencies and keeps target-specific
        // declarations and aliases: the same check applies to all of them.
        let mut p = package(
            "mdbn-hosted",
            true,
            json!([FEATURE]),
            json!({"hosted-service":["dep:migration"]}),
        );
        p["dependencies"][0]["kind"] = json!("dev");
        assert!(!check(p.clone()).is_empty());
        p["dependencies"][0]["kind"] = json!("build");
        p["dependencies"][0]["target"] = json!("cfg(windows)");
        assert!(!check(p).is_empty());
    }
    #[test]
    fn names_alone_do_not_authorize_external_or_misplaced_packages() {
        let p = package(
            "mdbn-hosted",
            true,
            json!([FEATURE]),
            json!({"hosted-service":["dep:migration"]}),
        );
        assert!(!violations(&json!({"workspace_members":[],"packages":[p.clone()]})).is_empty());
        let mut p = p;
        p["manifest_path"] = json!("/repo/crates/daemon/Cargo.toml");
        assert!(!check(p).is_empty());
    }
    #[test]
    fn migration_cannot_alias_custody_or_enable_it_by_default_and_cycles_terminate() {
        assert!(!check(json!({"name":"mdbn-migrate","features":{"default":["bridge"], "bridge":["hosted-service"]}})).is_empty());
        assert!(!check(json!({"name":"mdbn-migrate","features":{"default":[], "innocent":["bridge"], "bridge":["hosted-service"], "hosted-service":[]}})).is_empty(), "a renamed target feature must not bypass the dependency request audit");
        assert!(check(json!({"name":"mdbn-migrate","features":{"default":["a"], "a":["b"], "b":["a"], "hosted-service":[]}})).is_empty());
    }
}
