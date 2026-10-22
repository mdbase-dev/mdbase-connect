//! IANA timezone to region: where a migrated collection goes. The legacy service
//! recorded each collection's creating device timezone (`UTC` when unknown), so a
//! migrated collection is placed by that timezone rather than by the location of
//! whoever happens to run the migration.
//!
//! Fixed table, matched exactly (after trimming):
//! - Australia and New Zealand, and the other Pacific islands, map to `oc`;
//! - East, Southeast, South and Central Asia map to `apac`;
//! - Europe, Africa and the Middle East (including the Caucasus and Turkey) map
//!   to `weur`;
//! - US and Canadian Pacific and Mountain zones, Alaska, Hawaii and Mexico map to
//!   `wnam`, matching the country table, which puts Mexico in `wnam`;
//! - the rest of the Americas, and Bermuda and the Falklands, map to `enam`.
//!
//! `UTC`, `GMT`, `Etc/*`, Antarctica and anything unrecognised are unknown
//! (`None`).
use std::collections::BTreeMap;

use crate::placement::Region;

/// Asian zones that are the Middle East or the Caucasus.
const ASIA_WEUR: &str = "Asia/Aden Asia/Amman Asia/Baghdad Asia/Bahrain Asia/Baku Asia/Beirut \
    Asia/Damascus Asia/Dubai Asia/Famagusta Asia/Gaza Asia/Hebron Asia/Istanbul Asia/Jerusalem \
    Asia/Kuwait Asia/Muscat Asia/Nicosia Asia/Qatar Asia/Riyadh Asia/Tbilisi Asia/Tehran \
    Asia/Tel_Aviv Asia/Yerevan";
/// Indian Ocean zones nearer Oceania or Asia (the rest are African, `weur`).
const INDIAN_OC: &str = "Indian/Christmas Indian/Cocos";
const INDIAN_APAC: &str = "Indian/Chagos Indian/Maldives";
/// Pacific zones that are the Americas (the rest are Oceania).
const PACIFIC_WNAM: &str = "Pacific/Honolulu Pacific/Johnston Pacific/Midway";
const PACIFIC_ENAM: &str = "Pacific/Easter Pacific/Galapagos";
/// Atlantic zones in the Americas (the rest are European or African).
const ATLANTIC_ENAM: &str = "Atlantic/Bermuda Atlantic/Stanley Atlantic/South_Georgia";
/// American zones in US/Canada Pacific and Mountain time, Alaska and Mexico.
const AMERICA_WNAM: &str = "America/Adak America/Anchorage America/Atka America/Bahia_Banderas \
    America/Boise America/Cambridge_Bay America/Cancun America/Chihuahua America/Ciudad_Juarez \
    America/Creston America/Dawson America/Dawson_Creek America/Denver America/Edmonton \
    America/Ensenada America/Fort_Nelson America/Hermosillo America/Inuvik America/Juneau \
    America/Los_Angeles America/Matamoros America/Mazatlan America/Merida America/Metlakatla \
    America/Mexico_City America/Monterrey America/Nome America/Ojinaga America/Phoenix \
    America/Santa_Isabel America/Shiprock America/Sitka America/Tijuana America/Vancouver \
    America/Whitehorse America/Yakutat America/Yellowknife";
/// Backward-compatible link names outside the area prefixes.
const LINKS: &[(&str, Region)] = &[
    ("NZ", Region::Oc),
    ("NZ-CHAT", Region::Oc),
    ("Kwajalein", Region::Oc),
    ("Japan", Region::Apac),
    ("ROK", Region::Apac),
    ("PRC", Region::Apac),
    ("ROC", Region::Apac),
    ("Hongkong", Region::Apac),
    ("Singapore", Region::Apac),
    ("Eire", Region::Weur),
    ("GB", Region::Weur),
    ("GB-Eire", Region::Weur),
    ("Portugal", Region::Weur),
    ("Poland", Region::Weur),
    ("Iceland", Region::Weur),
    ("Egypt", Region::Weur),
    ("Libya", Region::Weur),
    ("Israel", Region::Weur),
    ("Iran", Region::Weur),
    ("Turkey", Region::Weur),
    ("CET", Region::Weur),
    ("EET", Region::Weur),
    ("MET", Region::Weur),
    ("WET", Region::Weur),
    ("Navajo", Region::Wnam),
    ("PST8PDT", Region::Wnam),
    ("MST", Region::Wnam),
    ("MST7MDT", Region::Wnam),
    ("HST", Region::Wnam),
    ("Cuba", Region::Enam),
    ("Jamaica", Region::Enam),
    ("EST", Region::Enam),
    ("EST5EDT", Region::Enam),
    ("CST6CDT", Region::Enam),
];
/// US and Canada link zones in Pacific/Mountain time, Alaska or Hawaii.
const US_CA_WNAM: &str = "US/Alaska US/Aleutian US/Arizona US/Hawaii US/Mountain US/Pacific \
    Canada/Mountain Canada/Pacific Canada/Yukon";

fn listed(list: &str, tz: &str) -> bool {
    list.split_ascii_whitespace().any(|x| x == tz)
}

/// The region for an IANA timezone, or `None` when it says nothing about where
/// the user is.
pub fn timezone_region(tz: &str) -> Option<Region> {
    let tz = tz.trim();
    if let Some(&(_, r)) = LINKS.iter().find(|(name, _)| *name == tz) {
        return Some(r);
    }
    let (area, _) = tz.split_once('/')?;
    Some(match area {
        "Australia" => Region::Oc,
        "Pacific" if listed(PACIFIC_WNAM, tz) => Region::Wnam,
        "Pacific" if listed(PACIFIC_ENAM, tz) => Region::Enam,
        "Pacific" => Region::Oc,
        "Asia" if listed(ASIA_WEUR, tz) => Region::Weur,
        "Asia" => Region::Apac,
        "Indian" if listed(INDIAN_OC, tz) => Region::Oc,
        "Indian" if listed(INDIAN_APAC, tz) => Region::Apac,
        "Indian" | "Europe" | "Africa" | "Arctic" => Region::Weur,
        "Atlantic" if listed(ATLANTIC_ENAM, tz) => Region::Enam,
        "Atlantic" => Region::Weur,
        "America" if listed(AMERICA_WNAM, tz) => Region::Wnam,
        "America" | "Brazil" | "Chile" => Region::Enam,
        "Mexico" => Region::Wnam,
        "US" | "Canada" if listed(US_CA_WNAM, tz) => Region::Wnam,
        "US" | "Canada" => Region::Enam,
        _ => return None,
    })
}

/// A migrated collection's region from the legacy timezones. Its own timezone when
/// that maps to a region. Otherwise (`UTC` or unknown), the owner's most common
/// mappable timezone across their other collections (ties: the earliest in the
/// given order; the control plane sends them newest first). `None` when neither
/// says anything; the caller then uses its default.
pub fn migration_region<'a>(
    own: Option<&str>,
    owner_others: impl IntoIterator<Item = &'a str>,
) -> Option<Region> {
    if let Some(r) = own.and_then(timezone_region) {
        return Some(r);
    }
    // Per timezone: (count, first position).
    let mut counts: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    for (i, tz) in owner_others.into_iter().enumerate() {
        let tz = tz.trim();
        if timezone_region(tz).is_some() {
            counts.entry(tz).or_insert((0, i)).0 += 1;
        }
    }
    // Highest count; on a tie, the earliest first position.
    let best = counts
        .iter()
        .max_by(|a, b| a.1.0.cmp(&b.1.0).then_with(|| b.1.1.cmp(&a.1.1)))?;
    timezone_region(best.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regions_by_area() {
        for (tz, r) in [
            ("Australia/Sydney", Region::Oc),
            ("Australia/Perth", Region::Oc),
            ("Pacific/Auckland", Region::Oc),
            ("Pacific/Fiji", Region::Oc),
            ("NZ", Region::Oc),
            ("Indian/Christmas", Region::Oc),
            ("Asia/Tokyo", Region::Apac),
            ("Asia/Singapore", Region::Apac),
            ("Asia/Kolkata", Region::Apac),
            ("Asia/Shanghai", Region::Apac),
            ("Indian/Maldives", Region::Apac),
            ("Europe/London", Region::Weur),
            ("Europe/Berlin", Region::Weur),
            ("Africa/Lagos", Region::Weur),
            ("Africa/Johannesburg", Region::Weur),
            ("Asia/Dubai", Region::Weur),
            ("Asia/Jerusalem", Region::Weur),
            ("Asia/Tehran", Region::Weur),
            ("Indian/Mauritius", Region::Weur),
            ("Atlantic/Reykjavik", Region::Weur),
            ("America/Los_Angeles", Region::Wnam),
            ("America/Vancouver", Region::Wnam),
            ("America/Denver", Region::Wnam),
            ("America/Phoenix", Region::Wnam),
            ("America/Edmonton", Region::Wnam),
            ("America/Anchorage", Region::Wnam),
            ("Pacific/Honolulu", Region::Wnam),
            ("America/Mexico_City", Region::Wnam),
            ("US/Pacific", Region::Wnam),
            ("America/New_York", Region::Enam),
            ("America/Chicago", Region::Enam),
            ("America/Toronto", Region::Enam),
            ("America/Winnipeg", Region::Enam),
            ("America/Halifax", Region::Enam),
            ("America/Sao_Paulo", Region::Enam),
            ("America/Argentina/Buenos_Aires", Region::Enam),
            ("America/Bogota", Region::Enam),
            ("Atlantic/Bermuda", Region::Enam),
            ("US/Eastern", Region::Enam),
            (" Europe/Paris ", Region::Weur),
        ] {
            assert_eq!(timezone_region(tz), Some(r), "{tz}");
        }
    }

    #[test]
    fn unknown_zones_say_nothing() {
        for tz in [
            "UTC",
            "GMT",
            "Etc/UTC",
            "Etc/GMT+5",
            "Antarctica/McMurdo",
            "",
            "europe/london",
            "Mars/Olympus",
            "Australia",
        ] {
            assert_eq!(timezone_region(tz), None, "{tz}");
        }
    }

    #[test]
    fn every_listed_zone_is_in_its_area_and_listed_once() {
        let mut seen = std::collections::BTreeSet::new();
        for (list, area) in [
            (ASIA_WEUR, "Asia/"),
            (INDIAN_OC, "Indian/"),
            (INDIAN_APAC, "Indian/"),
            (PACIFIC_WNAM, "Pacific/"),
            (PACIFIC_ENAM, "Pacific/"),
            (ATLANTIC_ENAM, "Atlantic/"),
            (AMERICA_WNAM, "America/"),
        ] {
            for tz in list.split_ascii_whitespace() {
                assert!(tz.starts_with(area), "{tz}");
                assert!(seen.insert(tz), "{tz} listed twice");
            }
        }
        for (name, _) in LINKS {
            assert!(!name.contains('/') && seen.insert(name), "{name}");
        }
    }

    #[test]
    fn own_timezone_then_the_owners_most_common_then_nothing() {
        let others = ["Europe/London", "UTC", "Asia/Tokyo", "Europe/London"];
        assert_eq!(
            migration_region(Some("Australia/Sydney"), others),
            Some(Region::Oc)
        );
        assert_eq!(migration_region(Some("UTC"), others), Some(Region::Weur));
        assert_eq!(migration_region(None, others), Some(Region::Weur));
        // Unknown zones never count; ties go to the earliest in the given order
        // (newest first), not the first name.
        assert_eq!(
            migration_region(Some("UTC"), ["UTC", "UTC", "Asia/Tokyo", "America/Denver"]),
            Some(Region::Apac)
        );
        assert_eq!(
            migration_region(Some("UTC"), ["America/Denver", "UTC", "Asia/Tokyo"]),
            Some(Region::Wnam)
        );
        assert_eq!(
            migration_region(
                None,
                [
                    "Europe/Paris",
                    "Asia/Tokyo",
                    "Asia/Tokyo",
                    "Europe/Paris",
                    "America/Denver",
                    "America/Denver",
                ]
            ),
            Some(Region::Weur)
        );
        // A count still beats position.
        assert_eq!(
            migration_region(None, ["Europe/Paris", "Asia/Tokyo", "Asia/Tokyo"]),
            Some(Region::Apac)
        );
        assert_eq!(migration_region(Some("UTC"), ["UTC", "Etc/GMT"]), None);
        assert_eq!(migration_region(Some("UTC"), []), None);
    }
}
