//! Host services for a native replica: the wall clock, the OS CSPRNG and
//! IANA time zones from the core's embedded tzdb.

use mdbn_core::cel::time::TimeZoneRules;
use mdbn_core::cel::time::tzdb::NamedZone;
use mdbn_core::host::{Clock, Entropy};
use mdbn_replica::TimeZones;
use mdbn_replica::crypto::CsprngEntropy;

/// `SystemTime::now()` in Unix milliseconds.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        now_ms()
    }
}

/// Unix milliseconds now.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// The operating system's CSPRNG (`getrandom`).
#[derive(Debug, Clone, Copy, Default)]
pub struct OsEntropy;

impl Entropy for OsEntropy {
    fn fill(&mut self, buf: &mut [u8]) {
        // The OS CSPRNG failing is not recoverable for a sealer or an ID mint.
        getrandom::fill(buf).expect("the OS CSPRNG is available");
    }
}

impl CsprngEntropy for OsEntropy {}

/// IANA zones from the core's pinned tzdb, with a configurable default zone.
#[derive(Debug, Clone)]
pub struct SystemZones {
    default: String,
}

impl SystemZones {
    /// Zones with `default` as the default zone (`settings.timezone`, or the
    /// machine's zone from [`SystemZones::machine_zone`]). An unknown name falls
    /// back to UTC.
    pub fn new(default: impl Into<String>) -> SystemZones {
        let d = default.into();
        let default = if NamedZone::get(&d).is_ok() {
            d
        } else {
            "UTC".into()
        };
        SystemZones { default }
    }

    /// The machine's zone: `$TZ`, then the `/etc/localtime` link target, then UTC.
    pub fn machine_zone() -> String {
        if let Ok(tz) = std::env::var("TZ")
            && NamedZone::get(&tz).is_ok()
        {
            return tz;
        }
        if let Ok(target) = std::fs::read_link("/etc/localtime")
            && let Some(s) = target.to_str()
            && let Some(i) = s.find("zoneinfo/")
        {
            let name = &s[i + "zoneinfo/".len()..];
            if NamedZone::get(name).is_ok() {
                return name.to_owned();
            }
        }
        "UTC".into()
    }
}

impl Default for SystemZones {
    fn default() -> Self {
        SystemZones::new(SystemZones::machine_zone())
    }
}

impl TimeZones for SystemZones {
    fn local_date(&self, instant_ms: i64, tz: &str) -> Option<String> {
        let zone = NamedZone::get(tz).ok()?;
        let secs = instant_ms.div_euclid(1000);
        let local = secs.checked_add(i64::from(zone.offset_at(secs)))?;
        let (y, m, d) = civil_from_days(local.div_euclid(86_400));
        Some(format!("{y:04}-{m:02}-{d:02}"))
    }

    fn default_zone(&self) -> String {
        self.default.clone()
    }
}

/// Proleptic Gregorian date of a day count since 1970-01-01 (Howard Hinnant's
/// `civil_from_days`; integer arithmetic only).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (
        y,
        u32::try_from(m).unwrap_or(1),
        u32::try_from(d).unwrap_or(1),
    )
}

/// A UUIDv7 from the clock and entropy (48-bit ms, version 7, variant 10).
pub fn uuid_v7(now_ms: u64, entropy: &mut dyn Entropy) -> [u8; 16] {
    let mut b = [0u8; 16];
    entropy.fill(&mut b);
    let ms = now_ms.to_be_bytes();
    b[..6].copy_from_slice(&ms[2..8]);
    b[6] = (b[6] & 0x0f) | 0x70;
    b[8] = (b[8] & 0x3f) | 0x80;
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    }

    #[test]
    fn local_date_follows_the_zone() {
        let z = SystemZones::new("UTC");
        // 2026-01-01T02:00Z is still 2025-12-31 in Los Angeles.
        let ms = 1_767_232_800_000;
        assert_eq!(z.local_date(ms, "UTC").as_deref(), Some("2026-01-01"));
        assert_eq!(
            z.local_date(ms, "America/Los_Angeles").as_deref(),
            Some("2025-12-31")
        );
        assert_eq!(z.local_date(ms, "Nowhere/Zone"), None);
        assert_eq!(SystemZones::new("Nowhere/Zone").default_zone(), "UTC");
    }

    #[test]
    fn v7_has_version_and_variant() {
        let u = uuid_v7(1_700_000_000_000, &mut OsEntropy);
        assert_eq!(u[6] >> 4, 7);
        assert_eq!(u[8] >> 6, 0b10);
        assert_eq!(&u[..6], &1_700_000_000_000u64.to_be_bytes()[2..]);
    }
}
