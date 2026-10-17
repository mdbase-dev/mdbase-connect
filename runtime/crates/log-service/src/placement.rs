//! Where a collection lives: its region, chosen once when the collection is
//! created and never changed. The region decides which object-store bucket holds
//! the collection's objects and where a host creates the collection's actor.
//!
//! A collection with no region (every collection created before regions
//! existed, and every collection created while no default is configured) keeps
//! the host's original bucket and placement.
//!
//! Choosing the region at creation (`create_log` key 2, `import` key 5, a
//! [`Placement`] map), in order:
//! 1. an explicit region (`oc`, `apac`, `wnam`, `enam`, `weur`);
//! 2. explicit `default`: the host's default region, ignoring any location;
//! 3. the legacy timezone of a migrated collection, then its owner's most common
//!    timezone across their other legacy collections ([`crate::timezone`]);
//! 4. the creating user's location (country, then continent; longitude splits
//!    North America east/west), mapped by [`nearest`];
//! 5. the host's default region, which may be none.
//!
//! The location must be the end user's, forwarded by the control plane (for
//! example from Cloudflare's visitor-location headers). The control plane's own
//! connection to the log service says where the control plane runs, not where the
//! user is, so hosts must not substitute it.
use mdbn_wire::cbor::Cbor;

use crate::error::{Result, ServiceError};

/// A storage region. Its string form is also the platform placement hint.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Region {
    /// Oceania.
    Oc,
    /// Asia-Pacific.
    Apac,
    /// Western North America.
    Wnam,
    /// Eastern North America.
    Enam,
    /// Western Europe.
    Weur,
}

impl Region {
    /// Every region.
    pub const ALL: [Region; 5] = [
        Region::Oc,
        Region::Apac,
        Region::Wnam,
        Region::Enam,
        Region::Weur,
    ];

    /// Parse the canonical lowercase name.
    pub fn parse(s: &str) -> Option<Region> {
        Region::ALL.into_iter().find(|r| r.as_str() == s)
    }

    /// Canonical lowercase name (and placement hint).
    pub fn as_str(self) -> &'static str {
        match self {
            Region::Oc => "oc",
            Region::Apac => "apac",
            Region::Wnam => "wnam",
            Region::Enam => "enam",
            Region::Weur => "weur",
        }
    }
}

/// The creating request's placement inputs (all optional).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Placement {
    /// `Some(None)` = explicit `default`; `Some(Some(r))` = explicit region.
    pub explicit: Option<Option<Region>>,
    /// ISO 3166-1 alpha-2 country of the creating user.
    pub country: Option<String>,
    /// Two-letter continent code of the creating user (`OC`, `AS`, `EU`, `AF`, `NA`, `SA`, `AN`).
    pub continent: Option<String>,
    /// Longitude of the creating user, degrees.
    pub longitude: Option<f64>,
    /// IANA timezone recorded for a migrated collection (`UTC` = unknown).
    pub timezone: Option<String>,
    /// The owner's timezones across their other legacy collections.
    pub owner_timezones: Vec<String>,
}

const MAX_TEXT: usize = 16;
/// IANA names are at most about 30 characters.
const MAX_TIMEZONE: usize = 64;
/// The owner-timezone list is bounded like other per-account vectors.
const MAX_OWNER_TIMEZONES: usize = 1000;

impl Placement {
    /// Parse the placement map `{0: region, 1: country, 2: continent, 3: longitude,
    /// 4: timezone, 5: [owner timezone]}` (all text, all optional). An unknown
    /// region name is refused, never ignored.
    pub fn parse(c: &Cbor) -> Result<Placement> {
        let bad = |what: &str| ServiceError::invalid("placement").msg(what.to_string());
        let Cbor::Map(m) = c else {
            return Err(bad("not a map"));
        };
        let mut p = Placement::default();
        for (k, v) in m {
            let Cbor::Uint(k) = k else {
                return Err(bad("key"));
            };
            let zone = |v: &Cbor| match v {
                Cbor::Text(t) if t.len() <= MAX_TIMEZONE => Ok(t.clone()),
                _ => Err(bad("timezone")),
            };
            if *k == 4 {
                p.timezone = Some(zone(v)?);
                continue;
            }
            if *k == 5 {
                let Cbor::Array(a) = v else {
                    return Err(bad("timezones"));
                };
                if a.len() > MAX_OWNER_TIMEZONES {
                    return Err(bad("timezones"));
                }
                p.owner_timezones = a.iter().map(zone).collect::<Result<_>>()?;
                continue;
            }
            let Cbor::Text(t) = v else {
                return Err(bad("value"));
            };
            if t.len() > MAX_TEXT {
                return Err(bad("value"));
            }
            match k {
                0 if t == "default" => p.explicit = Some(None),
                0 => p.explicit = Some(Some(Region::parse(t).ok_or_else(|| bad("region"))?)),
                1 => p.country = Some(t.to_ascii_uppercase()),
                2 => p.continent = Some(t.to_ascii_uppercase()),
                3 => {
                    let lon: f64 = t.parse().map_err(|_| bad("longitude"))?;
                    if !(-180.0..=180.0).contains(&lon) {
                        return Err(bad("longitude"));
                    }
                    p.longitude = Some(lon);
                }
                _ => return Err(bad("key")),
            }
        }
        Ok(p)
    }

    /// Parse an optional placement field.
    pub fn from_field(c: Option<&Cbor>) -> Result<Placement> {
        c.map_or(Ok(Placement::default()), Placement::parse)
    }

    /// The region to record for a new collection when every region is served.
    pub fn resolve(&self, default: Option<Region>) -> Option<Region> {
        self.resolve_in(&Regions::new(default, &Region::ALL))
            .unwrap_or(default)
    }

    /// The region to record for a new collection on a host serving `regions`.
    /// An explicit region the host does not serve is refused; a location whose
    /// nearest region is not served falls back to the default.
    pub fn resolve_in(&self, regions: &Regions) -> Result<Option<Region>> {
        match self.explicit {
            Some(Some(r)) if regions.served.contains(&r) => Ok(Some(r)),
            Some(Some(_)) => Err(ServiceError::invalid("placement").msg("region not served")),
            Some(None) => Ok(regions.default),
            None => Ok(crate::timezone::migration_region(
                self.timezone.as_deref(),
                self.owner_timezones.iter().map(String::as_str),
            )
            .filter(|r| regions.served.contains(r))
            .or_else(|| {
                nearest(
                    self.country.as_deref(),
                    self.continent.as_deref(),
                    self.longitude,
                )
                .filter(|r| regions.served.contains(r))
            })
            .or(regions.default)),
        }
    }
}

/// A host's regions: the default for new collections, and the regions it can
/// store (every region unless the host restricts them).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Regions {
    /// Region for a new collection that states none; `None` = no region.
    pub default: Option<Region>,
    /// Regions this host can store.
    pub served: Vec<Region>,
}

impl Default for Regions {
    fn default() -> Self {
        Regions::new(None, &Region::ALL)
    }
}

impl Regions {
    /// A default and the served set.
    pub fn new(default: Option<Region>, served: &[Region]) -> Self {
        Regions {
            default,
            served: served.to_vec(),
        }
    }
}

const OC: &str = "AU NZ FJ PG SB VU NC PF WS TO KI TV NR MH FM PW CK NU TK WF AS GU MP NF CX CC PN";
const APAC: &str = "CN HK MO TW JP KR KP MN SG MY ID TH VN PH KH LA MM BN TL IN PK BD LK NP BT MV \
    AF KZ UZ TM KG TJ IO";
const WEUR: &str = "AD AL AT AX BA BE BG BY CH CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS \
    IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XK \
    AE BH CY IL IQ IR JO KW LB OM PS QA SA SY TR YE GE AM AZ \
    DZ AO BJ BW BF BI CV CM CF TD KM CD CG CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY \
    MG MW ML MR MU YT MA MZ NA NE NG RE RW SH ST SN SC SL SO ZA SS SD TZ TG TN UG EH ZM ZW";
const ENAM: &str = "GT BZ SV HN NI CR PA CU JM HT DO PR BS BB TT AG DM GD KN LC VC AI AW BL BM BQ \
    CW GP KY MF MQ MS SX TC VG VI GL PM \
    AR BO BR CL CO EC FK GF GY PE PY SR UY VE GS";
const WNAM: &str = "MX";
/// Split by longitude when known; east without it (most of the population).
const NAM_SPLIT: &str = "US CA";
/// West of this longitude a North American user is nearer `wnam`.
const WNAM_WEST_OF: f64 = -100.0;

/// The nearest region to a user's location, or `None` when unknown.
pub fn nearest(country: Option<&str>, continent: Option<&str>, lon: Option<f64>) -> Option<Region> {
    let nam = || match lon {
        Some(l) if l <= WNAM_WEST_OF => Region::Wnam,
        _ => Region::Enam,
    };
    if let Some(c) = country.filter(|c| c.len() == 2) {
        let has = |list: &str| list.split_ascii_whitespace().any(|x| x == c);
        let by_country = [
            (OC, Region::Oc),
            (APAC, Region::Apac),
            (WEUR, Region::Weur),
            (ENAM, Region::Enam),
            (WNAM, Region::Wnam),
        ]
        .into_iter()
        .find(|(list, _)| has(list))
        .map(|(_, r)| r);
        if by_country.is_some() {
            return by_country;
        }
        if has(NAM_SPLIT) {
            return Some(nam());
        }
    }
    match continent? {
        "OC" => Some(Region::Oc),
        "AS" => Some(Region::Apac),
        "EU" | "AF" => Some(Region::Weur),
        "NA" => Some(nam()),
        "SA" => Some(Region::Enam),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(s: &str) -> Cbor {
        Cbor::Text(s.into())
    }

    #[test]
    fn region_names_round_trip() {
        for r in Region::ALL {
            assert_eq!(Region::parse(r.as_str()), Some(r));
        }
        assert_eq!(Region::parse("OC"), None);
        assert_eq!(Region::parse("sam"), None);
    }

    #[test]
    fn explicit_overrides_location_and_default() {
        let p = Placement::parse(&Cbor::Map(vec![
            (Cbor::Uint(0), text("weur")),
            (Cbor::Uint(1), text("AU")),
        ]))
        .unwrap();
        assert_eq!(p.resolve(Some(Region::Oc)), Some(Region::Weur));
        let d = Placement::parse(&Cbor::Map(vec![
            (Cbor::Uint(0), text("default")),
            (Cbor::Uint(1), text("DE")),
        ]))
        .unwrap();
        assert_eq!(d.resolve(Some(Region::Oc)), Some(Region::Oc));
        assert_eq!(d.resolve(None), None);
    }

    #[test]
    fn location_then_default() {
        let geo = |country: &str, continent: &str, lon: &str| {
            let mut m = vec![];
            for (k, v) in [(1, country), (2, continent), (3, lon)] {
                if !v.is_empty() {
                    m.push((Cbor::Uint(k), text(v)));
                }
            }
            Placement::parse(&Cbor::Map(m)).unwrap()
        };
        assert_eq!(geo("nz", "", "").resolve(None), Some(Region::Oc));
        assert_eq!(geo("JP", "", "").resolve(None), Some(Region::Apac));
        assert_eq!(geo("AE", "AS", "").resolve(None), Some(Region::Weur));
        assert_eq!(geo("US", "NA", "-122.4").resolve(None), Some(Region::Wnam));
        assert_eq!(geo("US", "NA", "-74.0").resolve(None), Some(Region::Enam));
        assert_eq!(geo("US", "", "").resolve(None), Some(Region::Enam));
        assert_eq!(geo("BR", "", "").resolve(None), Some(Region::Enam));
        assert_eq!(geo("", "EU", "").resolve(None), Some(Region::Weur));
        assert_eq!(
            geo("XX", "AN", "").resolve(Some(Region::Oc)),
            Some(Region::Oc)
        );
        assert_eq!(
            geo("", "", "").resolve(Some(Region::Apac)),
            Some(Region::Apac)
        );
        assert_eq!(Placement::default().resolve(None), None);
    }

    #[test]
    fn unserved_regions_refuse_explicit_and_skip_nearest() {
        let host = Regions::new(Some(Region::Oc), &[Region::Oc, Region::Wnam]);
        let p =
            |k: u64, v: &str| Placement::parse(&Cbor::Map(vec![(Cbor::Uint(k), text(v))])).unwrap();
        assert_eq!(p(0, "wnam").resolve_in(&host).unwrap(), Some(Region::Wnam));
        assert!(p(0, "weur").resolve_in(&host).is_err());
        assert_eq!(p(1, "DE").resolve_in(&host).unwrap(), Some(Region::Oc));
        assert_eq!(p(1, "US").resolve_in(&host).unwrap(), Some(Region::Oc));
        assert_eq!(p(2, "OC").resolve_in(&host).unwrap(), Some(Region::Oc));
    }

    #[test]
    fn legacy_timezones_place_migrated_collections() {
        let m = |own: &str, others: &[&str]| {
            Placement::parse(&Cbor::Map(vec![
                (Cbor::Uint(4), text(own)),
                (
                    Cbor::Uint(5),
                    Cbor::Array(others.iter().map(|t| text(t)).collect()),
                ),
            ]))
            .unwrap()
        };
        let host = Regions::new(Some(Region::Weur), &Region::ALL);
        assert_eq!(
            m("Asia/Tokyo", &[]).resolve_in(&host).unwrap(),
            Some(Region::Apac)
        );
        assert_eq!(
            m("UTC", &["America/Denver", "America/Denver", "Europe/Paris"])
                .resolve_in(&host)
                .unwrap(),
            Some(Region::Wnam)
        );
        assert_eq!(
            m("UTC", &["UTC"]).resolve_in(&host).unwrap(),
            Some(Region::Weur)
        );
        // An unserved timezone region falls back to the default, like a location.
        let small = Regions::new(Some(Region::Weur), &[Region::Weur, Region::Oc]);
        assert_eq!(
            m("Asia/Tokyo", &[]).resolve_in(&small).unwrap(),
            Some(Region::Weur)
        );
        // Timezone beats the location of whoever runs the migration.
        let both = Placement::parse(&Cbor::Map(vec![
            (Cbor::Uint(1), text("SG")),
            (Cbor::Uint(4), text("Australia/Sydney")),
        ]))
        .unwrap();
        assert_eq!(both.resolve_in(&host).unwrap(), Some(Region::Oc));
        let too_many = Cbor::Map(vec![(
            Cbor::Uint(5),
            Cbor::Array(vec![text("UTC"); MAX_OWNER_TIMEZONES + 1]),
        )]);
        assert!(Placement::parse(&too_many).is_err());
    }

    #[test]
    fn malformed_placement_is_refused() {
        for bad in [
            Cbor::Map(vec![(Cbor::Uint(0), text("mars"))]),
            Cbor::Map(vec![(Cbor::Uint(0), text("OC"))]),
            Cbor::Map(vec![(Cbor::Uint(3), text("200"))]),
            Cbor::Map(vec![(Cbor::Uint(9), text("x"))]),
            Cbor::Map(vec![(Cbor::Uint(1), Cbor::Uint(1))]),
            Cbor::Uint(0),
        ] {
            assert!(Placement::parse(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn every_listed_country_maps_to_exactly_one_region() {
        let mut seen = std::collections::BTreeSet::new();
        for list in [OC, APAC, WEUR, ENAM, WNAM, NAM_SPLIT] {
            for c in list.split_ascii_whitespace() {
                assert_eq!(c.len(), 2, "{c}");
                assert!(seen.insert(c), "{c} listed twice");
            }
        }
    }
}
