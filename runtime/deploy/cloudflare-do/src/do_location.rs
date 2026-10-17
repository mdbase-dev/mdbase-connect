//! Placement: where a collection's `LOG` actor is created and which R2 bucket
//! holds its objects. Both follow the collection's region
//! ([`mdbn_log_service::placement`]), chosen once at creation and stored in the
//! collection's metadata.
//!
//! - `LOGSVC_DO_LOCATION_HINT`: the default region (`oc`, `apac`, `wnam`, `enam`,
//!   `weur`) for new collections that give no explicit region or location, and the
//!   location hint for every actor stub that is not a collection's creating
//!   request (the registry included). Absent or empty: no default, platform
//!   placement, and new collections get no region (the original behaviour).
//! - `LOGSVC_REGION_BUCKETS`: `region=BINDING` pairs, comma separated, for
//!   example `oc=OBJECTS,wnam=OBJECTS_WNAM`. A collection with a region stores its
//!   objects in that region's bucket. A collection without a region (every
//!   collection created before regions existed) keeps the `OBJECTS` binding.
//!
//! The service records only regions with a bucket: an explicit unserved region
//! refuses creation, and a location nearest an unserved region gets the default.
//!
//! Invalid configuration is refused, never defaulted: an unknown region, a
//! malformed map, or a default region missing from the map makes the Worker
//! answer 503 to every request. A collection whose region is missing from the
//! map fails its object operations instead of writing to another bucket.
//! Location hints only affect actors that do not exist yet; existing actors stay
//! put. An actor first reached by a non-creating request (for example a stray
//! request for a collection that does not exist yet) is placed in the default
//! region; that costs latency, never correctness, because the bucket follows the
//! stored region.
use std::collections::BTreeMap;

use mdbn_log_service::placement::{Placement as Request, Region, Regions};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::log_service::LsRequest;
use worker::{Bucket, Env, ObjectNamespace, Result, Stub};

pub const ENV: &str = "LOGSVC_DO_LOCATION_HINT";
pub const BUCKETS_ENV: &str = "LOGSVC_REGION_BUCKETS";
/// Binding for regionless collections, unchanged from before regions.
pub const LEGACY_BUCKET: &str = "OBJECTS";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Placement {
    /// Default region for new collections and non-creating stubs.
    pub default: Option<Region>,
    /// Region to bucket binding name.
    pub buckets: BTreeMap<Region, String>,
}

impl Placement {
    pub fn parse(hint: Option<&str>, buckets: Option<&str>) -> std::result::Result<Self, String> {
        let default = match hint.map(str::trim) {
            None | Some("") => None,
            Some(v) => Some(Region::parse(v).ok_or_else(|| format!("{ENV}: unknown region"))?),
        };
        let mut map = BTreeMap::new();
        for pair in buckets.unwrap_or("").split(',').map(str::trim) {
            if pair.is_empty() {
                continue;
            }
            let (r, b) = pair
                .split_once('=')
                .ok_or_else(|| format!("{BUCKETS_ENV}: expected region=BINDING"))?;
            let r =
                Region::parse(r.trim()).ok_or_else(|| format!("{BUCKETS_ENV}: unknown region"))?;
            let b = b.trim();
            if b.is_empty() || map.insert(r, b.to_string()).is_some() {
                return Err(format!("{BUCKETS_ENV}: empty or repeated region"));
            }
        }
        if let Some(d) = default
            && !map.contains_key(&d)
        {
            return Err(format!("{BUCKETS_ENV}: no bucket for the default region"));
        }
        Ok(Placement {
            default,
            buckets: map,
        })
    }

    pub fn from_env(env: &Env) -> std::result::Result<Self, String> {
        let var = |k: &str| env.var(k).ok().map(|v| v.to_string());
        Self::parse(var(ENV).as_deref(), var(BUCKETS_ENV).as_deref())
    }

    /// Binding name for a collection's objects.
    pub fn binding(&self, region: Option<Region>) -> std::result::Result<&str, String> {
        match region {
            None => Ok(LEGACY_BUCKET),
            Some(r) => self
                .buckets
                .get(&r)
                .map(String::as_str)
                .ok_or_else(|| format!("{BUCKETS_ENV}: no bucket for region {}", r.as_str())),
        }
    }

    pub fn bucket(&self, env: &Env, region: Option<Region>) -> Result<Bucket> {
        env.bucket(self.binding(region).map_err(worker::Error::RustError)?)
    }

    /// Every binding this Worker may use (readiness probes).
    pub fn bindings(&self) -> Vec<&str> {
        let mut all: Vec<&str> = std::iter::once(LEGACY_BUCKET)
            .chain(self.buckets.values().map(String::as_str))
            .collect();
        all.sort_unstable();
        all.dedup();
        all
    }

    /// Region hint for the actor a request reaches. Only a collection's creating
    /// request (`create_log` key 2, `import` key 5) names its own region; every
    /// other request uses the default. A malformed placement falls back to the
    /// default here and is refused by the actor.
    pub fn hint_for(&self, r: Option<&LsRequest>) -> Option<Region> {
        let key = match r.map(|r| r.method.as_str()) {
            Some("create_log") => 2,
            Some("import") => 5,
            _ => return self.default,
        };
        let field = match &r.map(|r| &r.params) {
            Some(Cbor::Map(m)) => m
                .iter()
                .find(|(k, _)| *k == Cbor::Uint(key))
                .map(|(_, v)| v),
            _ => None,
        };
        Request::from_field(field)
            .and_then(|p| p.resolve_in(&self.regions()))
            .unwrap_or(self.default)
    }

    /// The default and the regions with a bucket, for the service.
    pub fn regions(&self) -> Regions {
        Regions::new(
            self.default,
            &self.buckets.keys().copied().collect::<Vec<_>>(),
        )
    }
}

/// The named actor's stub, created with `hint` when given.
pub fn stub(ns: &ObjectNamespace, name: &str, hint: Option<Region>) -> Result<Stub> {
    match hint {
        None => ns.get_by_name(name),
        Some(r) => ns.get_by_name_with_location_hint(name, r.as_str()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rpc(method: &str, fields: Vec<(u64, Cbor)>) -> LsRequest {
        LsRequest {
            id: 1,
            method: method.into(),
            params: Cbor::Map(
                fields
                    .into_iter()
                    .map(|(k, v)| (Cbor::Uint(k), v))
                    .collect(),
            ),
        }
    }
    fn place(fields: Vec<(u64, &str)>) -> Cbor {
        Cbor::Map(
            fields
                .into_iter()
                .map(|(k, v)| (Cbor::Uint(k), Cbor::Text(v.into())))
                .collect(),
        )
    }

    #[test]
    fn unset_keeps_the_original_placement_and_bucket() {
        for (h, b) in [(None, None), (Some(""), Some("")), (Some("  "), None)] {
            let p = Placement::parse(h, b).unwrap();
            assert_eq!(p, Placement::default());
            assert_eq!(p.hint_for(None), None);
            assert_eq!(p.hint_for(Some(&rpc("create_log", vec![]))), None);
            assert_eq!(p.binding(None), Ok(LEGACY_BUCKET));
            assert_eq!(p.bindings(), vec![LEGACY_BUCKET]);
        }
    }

    #[test]
    fn regions_route_to_their_buckets_and_regionless_to_the_original() {
        let p = Placement::parse(Some(" oc "), Some("oc=OBJECTS, wnam=OBJECTS_WNAM")).unwrap();
        assert_eq!(p.default, Some(Region::Oc));
        assert_eq!(p.binding(Some(Region::Oc)), Ok("OBJECTS"));
        assert_eq!(p.binding(Some(Region::Wnam)), Ok("OBJECTS_WNAM"));
        assert_eq!(p.binding(None), Ok("OBJECTS"));
        // Never another region's bucket.
        assert!(p.binding(Some(Region::Weur)).is_err());
        assert_eq!(p.bindings(), vec!["OBJECTS", "OBJECTS_WNAM"]);
    }

    #[test]
    fn invalid_configuration_is_refused_not_defaulted() {
        for (h, b) in [
            (Some("OC"), Some("oc=OBJECTS")),
            (Some("sam"), Some("oc=OBJECTS")),
            (Some("oc"), None),
            (Some("oc"), Some("wnam=OBJECTS_WNAM")),
            (None, Some("oc")),
            (None, Some("mars=OBJECTS")),
            (None, Some("oc=")),
            (None, Some("oc=A,oc=B")),
        ] {
            assert!(Placement::parse(h, b).is_err(), "{h:?} {b:?}");
        }
    }

    #[test]
    fn only_creating_requests_choose_the_actor_region() {
        let p = Placement::parse(Some("oc"), Some("oc=OBJECTS,wnam=W,weur=E")).unwrap();
        let explicit = place(vec![(0, "wnam")]);
        assert_eq!(
            p.hint_for(Some(&rpc("create_log", vec![(2, explicit.clone())]))),
            Some(Region::Wnam)
        );
        assert_eq!(
            p.hint_for(Some(&rpc("import", vec![(5, place(vec![(1, "DE")]))]))),
            Some(Region::Weur)
        );
        assert_eq!(
            p.hint_for(Some(&rpc("create_log", vec![]))),
            Some(Region::Oc)
        );
        // A migrated collection's legacy timezone places it.
        assert_eq!(
            p.hint_for(Some(&rpc(
                "create_log",
                vec![(2, place(vec![(4, "America/Denver")]))]
            ))),
            Some(Region::Wnam)
        );
        // A location nearest an unserved region uses the default.
        assert_eq!(
            p.hint_for(Some(&rpc("create_log", vec![(2, place(vec![(1, "JP")]))]))),
            Some(Region::Oc)
        );
        // Placement on any other method, or a malformed one, keeps the default.
        assert_eq!(
            p.hint_for(Some(&rpc("append", vec![(2, explicit)]))),
            Some(Region::Oc)
        );
        assert_eq!(
            p.hint_for(Some(&rpc(
                "create_log",
                vec![(2, place(vec![(0, "mars")]))]
            ))),
            Some(Region::Oc)
        );
        assert_eq!(p.hint_for(None), Some(Region::Oc));
    }
}
