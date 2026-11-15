//! Fixture artifact I/O and thin mappings to Core's document, schema and pack APIs.

use std::collections::BTreeMap;
use std::path::Path;

use mdbn_core::{doc::Document, jsonschema, paths::Glob, types::Catalog};
use serde_json::{Value, json};

use crate::ops::{Unsupported, from_core, to_core};

pub(crate) fn read(path: &str) -> Result<String, Unsupported> {
    std::fs::read_to_string(crate::repo_root().join("conformance/spec").join(path))
        .map_err(|_| Unsupported::NotImplemented("vendored fixture resource missing or unreadable"))
}

fn walk(root: &Path, directory: &Path, files: &mut Vec<String>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(directory)? {
        let path = entry?.path();
        if path.is_dir() {
            walk(root, &path, files)?;
        } else if let Ok(relative) = path.strip_prefix(root) {
            files.push(relative.to_string_lossy().into_owned());
        }
    }
    Ok(())
}

pub(crate) fn paths(patterns: &[String]) -> Result<Vec<String>, Unsupported> {
    let root = crate::repo_root().join("conformance/spec");
    let mut files = Vec::new();
    walk(&root, &root, &mut files)
        .map_err(|_| Unsupported::NotImplemented("vendored fixture directory unreadable"))?;
    let mut selected = Vec::new();
    for pattern in patterns {
        let glob =
            Glob::new(pattern).map_err(|_| Unsupported::NotImplemented("invalid fixture glob"))?;
        let matching: Vec<_> = files
            .iter()
            .filter(|path| glob.matches(path))
            .cloned()
            .collect();
        if matching.is_empty() {
            return Err(Unsupported::NotImplemented("fixture glob matched no files"));
        }
        selected.extend(matching);
    }
    selected.sort();
    selected.dedup();
    Ok(selected)
}

fn input_paths(input: &Value) -> Vec<String> {
    input["paths"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .chain(input["path"].as_str())
        .map(str::to_owned)
        .collect()
}

fn requires_full_schema_profile(schema: &Value) -> bool {
    let Some(object) = schema.as_object() else {
        return false;
    };
    object.keys().any(|key| {
        matches!(
            key.as_str(),
            "contains"
                | "minContains"
                | "maxContains"
                | "dependentRequired"
                | "dependentSchemas"
                | "propertyNames"
                | "unevaluatedProperties"
                | "unevaluatedItems"
                | "$dynamicRef"
                | "$recursiveRef"
        )
    }) || object.iter().any(|(key, value)| match key.as_str() {
        "properties" | "patternProperties" | "$defs" | "definitions" => value
            .as_object()
            .is_some_and(|schemas| schemas.values().any(requires_full_schema_profile)),
        "allOf" | "anyOf" | "oneOf" | "prefixItems" => value
            .as_array()
            .is_some_and(|schemas| schemas.iter().any(requires_full_schema_profile)),
        "items" | "additionalProperties" | "not" | "if" | "then" | "else" => {
            requires_full_schema_profile(value)
        }
        _ => false,
    })
}

pub(crate) fn catalog(contracts: &[String], types: &[String]) -> Result<Catalog, Unsupported> {
    let mut resources = BTreeMap::new();
    for (index, (path, kind)) in paths(contracts)?
        .into_iter()
        .map(|path| (path, "contracts"))
        .chain(paths(types)?.into_iter().map(|path| (path, "types")))
        .enumerate()
    {
        let mapped = ["_contracts/", "_types/"].into_iter().find_map(|marker| {
            if path.starts_with(marker) {
                Some(("", path.clone()))
            } else {
                path.split_once(&format!("/{marker}"))
                    .map(|(root, suffix)| (root, format!("{marker}{suffix}")))
            }
        });
        let target = match mapped {
            Some((root, target)) => {
                let prefix = if root.is_empty() {
                    String::new()
                } else {
                    format!("{root}/")
                };
                let schema_root = format!("{prefix}schemas");
                if crate::repo_root()
                    .join("conformance/spec")
                    .join(&schema_root)
                    .is_dir()
                {
                    for schema in paths(&[format!("{schema_root}/**/*.json")])? {
                        resources.insert(schema[prefix.len()..].to_owned(), read(&schema)?);
                    }
                }
                target
            }
            None => format!("_{kind}/{index}.md"),
        };
        resources.insert(target, read(&path)?);
    }
    Ok(Catalog::load(
        resources
            .iter()
            .map(|(path, source)| (path.as_str(), source.as_str())),
    ))
}

pub(crate) fn run(operation: &str, input: &Value, expect: &Value) -> Result<Value, Unsupported> {
    let paths = paths(&input_paths(input))?;
    if paths.is_empty() {
        return Err(Unsupported::NotImplemented(
            "fixture artifact paths missing",
        ));
    }
    if operation == "type_pack_resources_validate" {
        let path = &paths[0];
        let folder = Path::new(path).parent().unwrap_or(Path::new(""));
        return Ok(
            match mdbn_core::packs::load_pack(&read(path)?, &|source| {
                read(&folder.join(source).to_string_lossy()).ok()
            }) {
                Ok(_) => json!({"valid": true}),
                Err(issue) => {
                    json!({"valid": false, "diagnostics": [crate::ops_b::issue_json(&issue)]})
                }
            },
        );
    }
    let schema = if operation.ends_with("_schema_validate") {
        let source = read(
            input["schema"]
                .as_str()
                .ok_or(Unsupported::NotImplemented("fixture schema missing"))?,
        )?;
        let document: Value = serde_json::from_str(&source)
            .map_err(|_| Unsupported::NotImplemented("fixture schema is not JSON"))?;
        if requires_full_schema_profile(&document) {
            return Err(Unsupported::NotImplemented(
                "artifact requires JSON Schema keywords outside Core's declared profile",
            ));
        }
        Some(jsonschema::compile(&to_core(&document), "").map_err(|_| {
            Unsupported::NotImplemented("artifact schema outside the Core JSON Schema profile")
        })?)
    } else {
        None
    };
    let mut valid = true;
    let mut documents = Vec::new();
    let mut diagnostics = Vec::new();
    for path in paths {
        let source = read(&path)?;
        let document = if operation.starts_with("json_document") {
            serde_json::from_str::<Value>(&source).ok()
        } else if path.ends_with(".md") {
            let document = Document::parse_at(&path, &source);
            document.problem().is_none().then(|| {
                from_core(&mdbn_core::value::Value::Map(
                    document.frontmatter().clone(),
                ))
            })
        } else {
            mdbn_core::yaml::parse_value(&source)
                .ok()
                .flatten()
                .map(|value| from_core(&value))
        };
        let Some(document) = document else {
            valid = false;
            continue;
        };
        if let Some(schema) = &schema {
            for issue in schema.validate(&to_core(&document)) {
                diagnostics
                    .push(json!({"path": path, "code": issue.code, "message": issue.message}));
                valid = false;
            }
        }
        if operation == "inspect_yaml" {
            documents.push(document);
        }
    }
    let pointers = |key: &str, present: bool| {
        expect[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|pointer| {
                pointer.as_str().is_some_and(|pointer| {
                    !documents.is_empty()
                        && documents
                            .iter()
                            .all(|document| document.pointer(pointer).is_some() == present)
                })
            })
            .cloned()
            .collect::<Vec<_>>()
    };
    Ok(
        json!({"valid": valid, "has": pointers("has", true), "not_has": pointers("not_has", false), "diagnostics": diagnostics}),
    )
}
